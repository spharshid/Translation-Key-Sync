import * as fs from 'fs/promises';
import * as path from 'path';
import { applyEdits, modify, parse, ParseError } from 'jsonc-parser';
import type { PromptItem } from './ai/prompt';
import { dottedPath, pickReferences } from './ai/refs';
import { addIssue, Issue, jsonProblem, structureProblem } from './issues';
import type { PendingEntry, PendingStore } from './pending';
import type { TranslationService } from './translation';

export type KeyPath = (string | number)[];
export interface Change {
	path: KeyPath;
	/** the new value (string, array, number, boolean, null); ignored when `deleted` */
	value?: unknown;
	deleted?: boolean;
}

export interface Format {
	eol: string;
	insertSpaces: boolean;
	tabSize: number;
	finalNewline: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Leaf-level differences between two parsed JSON documents (old may be null for a new file). */
export function diffJson(oldDoc: unknown, newDoc: unknown): Change[] {
	const changes: Change[] = [];
	const collectDeleted = (v: unknown, p: KeyPath) => {
		if (isObj(v)) {
			for (const k of Object.keys(v)) {
				collectDeleted(v[k], [...p, k]);
			}
		} else {
			changes.push({ path: p, deleted: true });
		}
	};
	const walk = (o: unknown, n: unknown, p: KeyPath) => {
		const oo = isObj(o) ? o : {};
		const nn = isObj(n) ? n : {};
		for (const key of Object.keys(nn)) {
			const nv = nn[key];
			const ov = oo[key];
			if (isObj(nv)) {
				walk(ov, nv, [...p, key]);
			} else if (JSON.stringify(nv) !== JSON.stringify(ov)) {
				changes.push({ path: [...p, key], value: nv });
			}
		}
		for (const key of Object.keys(oo)) {
			if (!(key in nn)) {
				collectDeleted(oo[key], [...p, key]);
			}
		}
	};
	walk(oldDoc, newDoc, []);
	return changes;
}

export function detectFormat(text: string): Format {
	const eol = text.includes('\r\n') ? '\r\n' : '\n';
	const indent = /^[ \t]+/m.exec(text)?.[0] ?? '  ';
	return { eol, insertSpaces: !indent.includes('\t'), tabSize: indent.length, finalNewline: text.endsWith('\n') };
}

export interface SyncStats {
	written: number;
	files: number;
	/** strings no translator could handle in time: English was written and queued */
	pending: number;
	/** strings written from machine translation only (queued for an AI redo when AI is configured) */
	machine: number;
	created: number;
	/** keys re-read from disk after writing and found correct */
	verified: number;
	/** keys left alone because they were already translated from the same text */
	skipped: number;
	/** strings filled from an existing approved translation of the same text */
	reused: number;
	/** files and keys that were left untouched because their content is broken */
	issues: Issue[];
}

export const newStats = (): SyncStats => ({ written: 0, files: 0, pending: 0, machine: 0, created: 0, verified: 0, skipped: 0, reused: 0, issues: [] });

export interface SyncCtx {
	service: TranslationService;
	sourceLocale: string;
	log: (m: string) => void;
	stats: SyncStats;
	pending?: PendingStore;
	/** true when this key is already translated for exactly this source text, so it can be left alone */
	isUpToDate?: (rel: string, change: Change, targetDoc: unknown) => Promise<boolean>;
}

export interface FileJob {
	/** path of the file relative to the locale folder, e.g. "common.json" or "admin/menu.json" */
	rel: string;
	targetFile: string;
	changes: Change[];
	/** every key of the source file: used to create the target file when it does not exist yet */
	allKeys: Change[];
	sourceFormat: Format;
	/** the parsed source-language file (used to find approved translations to show the model) */
	sourceDoc: unknown;
	locale: string;
}

/** Number of strings that will need translating for these changes (used to estimate the work). */
export function countStrings(v: unknown): number {
	if (typeof v === 'string') {
		return v.trim() ? 1 : 0;
	}
	return Array.isArray(v) ? v.reduce<number>((n, x) => n + countStrings(x), 0) : 0;
}

export function valueAt(doc: unknown, p: KeyPath): unknown {
	let cur: any = doc;
	for (const k of p) {
		if (cur === null || typeof cur !== 'object' || !(k in cur)) {
			return undefined;
		}
		cur = cur[k];
	}
	return cur;
}

/** Re-read the file from disk and make sure every key we meant to write is there with the right value. */
export async function verifyFile(targetFile: string, expected: Map<Change, unknown>): Promise<number> {
	const errors: ParseError[] = [];
	const doc = parse((await fs.readFile(targetFile, 'utf8')).replace(/^﻿/, ''), errors, { allowTrailingComma: true });
	if (errors.length) {
		throw new Error(`${targetFile} is not valid JSON after the sync`);
	}
	for (const [c, want] of expected) {
		const got = valueAt(doc, c.path);
		if (c.deleted ? got !== undefined : JSON.stringify(got) !== JSON.stringify(want)) {
			throw new Error(`verification failed: ${c.path.join('.')} in ${targetFile}`);
		}
	}
	return expected.size;
}

/**
 * Apply source changes for one file to one locale's copy, editing in place so formatting is preserved.
 * If the target file does not exist it is created from `allKeys`, formatted like the source.
 * Returns the changes that were applied (the caller records them in the snapshot).
 */
export async function syncFileToLocale(ctx: SyncCtx, job: FileJob): Promise<Change[]> {
	const { service, log, stats } = ctx;
	const { targetFile, locale } = job;
	let raw: string;
	let bom = '';
	let existed = true;
	try {
		raw = await fs.readFile(targetFile, 'utf8');
		if (raw.startsWith('﻿')) {
			bom = '﻿';
			raw = raw.slice(1);
		}
	} catch {
		existed = false;
		raw = '{}' + (job.sourceFormat.finalNewline ? job.sourceFormat.eol : '');
	}
	if (existed && !raw.trim()) {
		raw = '{}' + (job.sourceFormat.finalNewline ? job.sourceFormat.eol : ''); // an empty file counts as an empty object
	}
	const base = { file: targetFile, rel: job.rel, locale };
	const bad = existed ? jsonProblem(raw) : undefined;
	if (bad) {
		// never write into a file that is not valid JSON: it would stay broken, and the rest of the sync must go on
		addIssue(stats.issues, { ...base, kind: 'invalid-json', message: bad.message, line: bad.line });
		log(`[${locale}] skip ${job.rel}: not valid JSON (line ${bad.line}: ${bad.message}); the file was not touched`);
		return [];
	}
	const fmt = existed ? detectFormat(raw) : job.sourceFormat;
	const targetDoc = existed ? parse(raw) : null;

	const work: Change[] = [];
	for (const c of existed ? job.changes : job.allKeys) {
		const clash = existed && !c.deleted ? structureProblem(targetDoc, c.path) : undefined;
		if (clash) {
			addIssue(stats.issues, { ...base, kind: 'structure', message: clash, key: dottedPath(c.path) });
			log(`[${locale}] skip ${dottedPath(c.path)} in ${job.rel}: ${clash}`);
			continue;
		}
		if (existed && !c.deleted && locale !== ctx.sourceLocale && (await ctx.isUpToDate?.(job.rel, c, targetDoc))) {
			stats.skipped++;
			continue;
		}
		work.push(c);
	}

	// every string that needs translating goes out as one batch with its key path and nearby approved translations
	const items: PromptItem[] = [];
	const idOf = new Map<string, string>();
	const collect = (v: unknown, ci: number, at: KeyPath) => {
		if (typeof v === 'string') {
			const id = `s${items.length}`;
			idOf.set(`${ci}|${JSON.stringify(at)}`, id);
			items.push({ id, text: v, keyPath: dottedPath(at) });
		} else if (Array.isArray(v)) {
			v.forEach((x, i) => collect(x, ci, [...at, i]));
		}
	};
	if (locale !== ctx.sourceLocale) {
		work.forEach((c, ci) => !c.deleted && collect(c.value, ci, c.path));
	}
	const results = items.length
		? await service.translateBatch({
				locale,
				file: job.rel,
				items,
				refs: pickReferences(job.sourceDoc, targetDoc, items),
			})
		: new Map();

	const translated = new Map<Change, unknown>();
	const pending: PendingEntry[] = [];
	const build = (v: unknown, ci: number, at: KeyPath): unknown => {
		if (typeof v === 'string') {
			const r = results.get(idOf.get(`${ci}|${JSON.stringify(at)}`) ?? '');
			if (!r) {
				return v;
			}
			if (r.origin === 'memory') {
				stats.reused++;
			} else if (r.origin === 'english') {
				stats.pending++;
				pending.push({ file: targetFile, path: at, text: v, locale, since: Date.now(), kind: 'english', written: v });
				log(`[${locale}] ${dottedPath(at)} could not be translated yet; wrote English and queued it for retry`);
			} else if (r.origin === 'classic' && service.aiIntended) {
				stats.machine++;
				pending.push({ file: targetFile, path: at, text: v, locale, since: Date.now(), kind: 'lowconf', written: r.value });
			}
			if (r.warnings.length) {
				log(`[${locale}] ${dottedPath(at)}: ${r.warnings.join('; ')}`);
			}
			return r.value;
		}
		return Array.isArray(v) ? v.map((x, i) => build(x, ci, [...at, i])) : v;
	};
	work.forEach((c, ci) => {
		translated.set(c, c.deleted ? undefined : locale === ctx.sourceLocale ? c.value : build(c.value, ci, c.path));
	});

	let updated = raw;
	for (const c of work) {
		const edits = modify(updated, c.path, translated.get(c), {
			formattingOptions: { eol: fmt.eol, insertSpaces: fmt.insertSpaces, tabSize: fmt.tabSize },
		});
		updated = applyEdits(updated, edits);
		stats.written++;
	}

	if (updated !== raw || !existed) {
		await fs.mkdir(path.dirname(targetFile), { recursive: true });
		await fs.writeFile(targetFile, bom + updated, 'utf8');
		stats.files++;
		if (!existed) {
			stats.created++;
		}
		log(`[${locale}] ${existed ? 'updated' : 'created'} ${path.basename(targetFile)} (${work.length} keys)`);
	}
	if (pending.length) {
		await ctx.pending?.add(pending);
	}
	if (work.length) {
		stats.verified += await verifyFile(targetFile, translated);
	}
	return work;
}
