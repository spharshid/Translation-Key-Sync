import * as fs from 'fs/promises';
import * as path from 'path';
import { applyEdits, modify, parse, ParseError } from 'jsonc-parser';
import type { PendingEntry, PendingStore } from './pending';
import { Translator } from './translator';

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
	/** strings that could not be translated in time: written in English and queued for retry */
	pending: number;
	created: number;
	/** keys re-read from disk after writing and found correct */
	verified: number;
}

export interface SyncCtx {
	translator: Translator;
	log: (m: string) => void;
	stats: SyncStats;
	pending?: PendingStore;
}

async function mapLimit<T>(items: T[], limit: number, fn: (t: T) => Promise<void>) {
	let i = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (i < items.length) {
				await fn(items[i++]);
			}
		}),
	);
}

/** Number of strings that will need translating for these changes (used to pick a provider strategy). */
export function countStrings(v: unknown): number {
	if (typeof v === 'string') {
		return v.trim() ? 1 : 0;
	}
	return Array.isArray(v) ? v.reduce<number>((n, x) => n + countStrings(x), 0) : 0;
}

function valueAt(doc: unknown, p: KeyPath): unknown {
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
 * If the target file does not exist it is created from `allKeys` (every key of the source file), formatted like the source.
 */
export async function syncFileToLocale(
	ctx: SyncCtx,
	targetFile: string,
	changes: Change[],
	allKeys: Change[],
	sourceFormat: Format,
	locale: string,
): Promise<void> {
	const { translator, log, stats } = ctx;
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
		raw = '{}' + (sourceFormat.finalNewline ? sourceFormat.eol : '');
	}
	const fmt = existed ? detectFormat(raw) : sourceFormat;
	const work = existed ? changes : allKeys;

	// translate (a few at a time), then apply the edits in order
	const translated = new Map<Change, unknown>();
	const pending: PendingEntry[] = [];
	const translateValue = async (v: unknown, c: Change, at: KeyPath): Promise<unknown> => {
		if (typeof v === 'string') {
			const r = await translator.translate(v, locale);
			if (r.fellBack) {
				stats.pending++;
				pending.push({ file: targetFile, path: at, text: v, locale, since: Date.now() });
				log(`[${locale}] ${at.join('.')} could not be translated yet; wrote English and queued it for retry`);
			}
			return r.value;
		}
		if (Array.isArray(v)) {
			const out: unknown[] = [];
			for (const [i, x] of v.entries()) {
				out.push(await translateValue(x, c, [...at, i]));
			}
			return out;
		}
		return v; // numbers, booleans, null are language independent
	};
	await mapLimit(work, 4, async (c) => {
		translated.set(c, c.deleted ? undefined : await translateValue(c.value, c, c.path));
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
}
