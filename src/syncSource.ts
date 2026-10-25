import { existsSync } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { parse } from 'jsonc-parser';
import { dottedPath } from './ai/refs';
import { Destination, isInside, targetsOf } from './destinations';
import { git, jsonAt } from './git';
import { addIssue, Issue, jsonProblem, structureProblem } from './issues';
import { hashValue } from './snapshot';
import { Change, SyncStats, countStrings, detectFormat, diffJson, newStats, syncFileToLocale, valueAt } from './sync';
import { SyncConfig, SyncDeps, upToDateCheck } from './syncCommit';

export interface SourceSyncResult {
	stats: SyncStats;
	/** source files that had something to write somewhere */
	filesWithChanges: number;
}

async function listJson(dir: string, base = dir): Promise<string[]> {
	let entries: import('fs').Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const out: string[] = [];
	for (const e of entries) {
		const full = path.join(dir, e.name);
		if (e.isDirectory()) {
			if (!e.name.startsWith('.') && e.name !== 'node_modules') {
				out.push(...(await listJson(full, base)));
			}
		} else if (e.name.endsWith('.json')) {
			out.push(path.relative(base, full).split(path.sep).join('/'));
		}
	}
	return out.sort();
}

const readJson = async (file: string): Promise<{ raw: string; doc: unknown } | null> => {
	try {
		const raw = (await fs.readFile(file, 'utf8')).replace(/^﻿/, '');
		return { raw, doc: parse(raw) };
	} catch {
		return null;
	}
};

/** Keys edited in the working tree since the last commit of the source's repo (when it is a git repo). */
async function uncommittedChanges(gitPath: string, file: string): Promise<Change[]> {
	try {
		const root = (await git(gitPath, path.dirname(file), ['rev-parse', '--show-toplevel'])).trim();
		const rel = path.relative(root, file).split(path.sep).join('/');
		const head = await jsonAt(gitPath, root, 'HEAD', rel);
		const now = await readJson(file);
		return head && now ? diffJson(head.doc, now.doc) : [];
	} catch {
		return []; // not a git repo, or the file is new: everything missing in a target is picked up anyway
	}
}

/** Why a target file needs work: which keys are absent and which were synced from an older text. */
interface Detail {
	fileMissing: boolean;
	missing: string[];
	outdated: string[];
}

interface Target {
	dest: Destination;
	locale: string;
	file: string;
	changes: Change[];
	detail: Detail;
}

interface Plan {
	rel: string;
	srcRaw: string;
	srcDoc: unknown;
	allKeys: Change[];
	/** keys that were removed from the source since a destination last synced, per destination */
	removed: Map<string, Change[]>;
	targets: Target[];
}

/**
 * What every source file asks of every destination. Nothing is written. Files that are not valid JSON, and keys whose place
 * in a target file clashes with the source, are not planned; they are reported in `issues` instead.
 */
async function planSource(cfg: SyncConfig, deps: Pick<SyncDeps, 'snapshots'>, gitPath: string, log: (m: string) => void, issues: Issue[]): Promise<Plan[]> {
	const files = await listJson(cfg.sourceDir);
	if (!files.length) {
		log(`no .json files found in ${cfg.sourceDir}`);
	}

	const plans: Plan[] = [];
	for (const rel of files) {
		const srcFile = path.join(cfg.sourceDir, rel);
		const src = await readJson(srcFile);
		const bad = src ? jsonProblem(src.raw) : undefined;
		if (!src || bad || src.doc === undefined) {
			const why = bad ?? { message: 'empty file', line: 1 };
			addIssue(issues, { file: srcFile, rel, locale: cfg.sourceLocale, kind: 'invalid-json', message: why.message, line: why.line });
			log(`skip ${rel}: the source file is not valid JSON (line ${why.line}: ${why.message})`);
			continue;
		}
		const allKeys = diffJson(null, src.doc);
		const present = new Set(allKeys.map((c) => JSON.stringify(c.path)));
		const uncommitted = await uncommittedChanges(gitPath, srcFile);

		const removedBy = new Map<string, Change[]>();
		const targets: Target[] = [];
		for (const dest of cfg.destinations) {
			// edited since this destination was last synced: from its snapshot (hash differs) and from uncommitted edits (vs HEAD)
			const edited = new Map<string, Change>();
			const removed = new Map<string, Change>();
			for (const { path: p, hash } of (await deps.snapshots?.scope(dest.path).keysOf(rel)) ?? []) {
				const k = JSON.stringify(p);
				if (!present.has(k)) {
					removed.set(k, { path: p, deleted: true });
				} else if (hash !== hashValue(valueAt(src.doc, p))) {
					edited.set(k, { path: p, value: valueAt(src.doc, p) });
				}
			}
			for (const c of uncommitted) {
				(c.deleted ? removed : edited).set(JSON.stringify(c.path), c);
			}
			removedBy.set(dest.path, [...removed.values()]);

			for (const { locale, file } of targetsOf(dest, cfg.locales, cfg.sourceLocale, rel, srcFile)) {
				const t = await readJson(file);
				const changes: Change[] = [];
				const detail: Detail = { fileMissing: !t, missing: [], outdated: [] };
				const broken = t ? jsonProblem(t.raw) : undefined;
				if (broken) {
					addIssue(issues, { file, rel, locale, kind: 'invalid-json', message: broken.message, line: broken.line });
				} else if (t) {
					for (const c of allKeys) {
						const clash = structureProblem(t.doc, c.path);
						if (clash) {
							addIssue(issues, { file, rel, locale, kind: 'structure', message: clash, key: dottedPath(c.path) });
							continue;
						}
						const absent = valueAt(t.doc, c.path) === undefined;
						if (absent || edited.has(JSON.stringify(c.path))) {
							changes.push(c);
							(absent ? detail.missing : detail.outdated).push(dottedPath(c.path));
						}
					}
					for (const [k, c] of removed) {
						if (valueAt(t.doc, JSON.parse(k)) !== undefined) {
							changes.push(c);
						}
					}
				} else {
					detail.missing = allKeys.map((c) => dottedPath(c.path));
				}
				targets.push({ dest, locale, file, changes, detail });
			}
		}
		plans.push({ rel, srcRaw: src.raw, srcDoc: src.doc, allKeys, removed: removedBy, targets });
	}
	return plans;
}

export interface ScanEntry {
	/** the language, or "<folder> (copy)" for a destination that gets the base language as it is */
	locale: string;
	file: string;
	rel: string;
	keys: string[];
}

export interface ScanResult {
	/** keys the source has that a target file lacks (a missing file lists all of its keys) */
	missing: ScanEntry[];
	/** keys whose source text was edited since the destination last synced them */
	outdated: ScanEntry[];
	/** files and keys a sync cannot touch until someone fixes them */
	issues: Issue[];
	files: number;
}

/** A dry run of Sync Locales: what is not synced yet and what is broken, without writing anything. */
export async function scanSource(cfg: SyncConfig, deps: Pick<SyncDeps, 'snapshots'>, gitPath: string, log: (m: string) => void): Promise<ScanResult> {
	const issues: Issue[] = [];
	const plans = await planSource(cfg, deps, gitPath, log, issues);
	const out: ScanResult = { missing: [], outdated: [], issues, files: plans.length };
	for (const p of plans) {
		for (const t of p.targets) {
			const locale = t.dest.mode === 'copy' ? `${path.basename(t.dest.path)} (copy)` : t.locale;
			if (t.detail.missing.length) {
				out.missing.push({ locale, file: t.file, rel: p.rel, keys: t.detail.missing });
			}
			if (t.detail.outdated.length) {
				out.outdated.push({ locale, file: t.file, rel: p.rel, keys: t.detail.outdated });
			}
		}
	}
	return out;
}

/**
 * State-based sync: every new or edited key of the source folder is translated into the "translate" destinations and copied
 * as it is into the "copy" destinations. What counts as new or edited is judged per destination, so a destination that was
 * left out of an earlier run still receives those changes the next time it is included.
 */
export async function syncFromSource(cfg: SyncConfig, deps: SyncDeps, gitPath: string, log: (m: string) => void): Promise<SourceSyncResult> {
	const stats = newStats();
	const plans = await planSource(cfg, deps, gitPath, log, stats.issues);

	const work = plans.filter((p) => p.targets.some((t) => t.changes.length || !existsSync(t.file)));
	const expected = work.reduce(
		(n, p) =>
			n +
			p.targets
				.filter((t) => t.locale !== cfg.sourceLocale)
				.reduce((m, t) => m + countStrings((existsSync(t.file) ? t.changes : p.allKeys).map((x) => x.value)), 0),
		0,
	);
	const service = await deps.makeService(expected);
	log(`${work.length} file(s) to check in ${cfg.destinations.length} destination(s), about ${expected} string(s) to translate`);

	let filesWithChanges = 0;
	for (const p of work) {
		const format = detectFormat(p.srcRaw);
		let touched = false;
		for (const t of p.targets) {
			if (!t.changes.length && existsSync(t.file)) {
				continue;
			}
			touched = true;
			const ctx = { service, sourceLocale: cfg.sourceLocale, log, stats, pending: deps.pending, isUpToDate: upToDateCheck(deps.snapshots?.scope(t.dest.path)) };
			await syncFileToLocale(ctx, { rel: p.rel, targetFile: t.file, changes: t.changes, allKeys: p.allKeys, sourceFormat: format, sourceDoc: p.srcDoc, locale: t.locale });
		}
		if (touched) {
			filesWithChanges++;
		}
	}
	// remember what every key was synced from, also for files that needed nothing now (that is the baseline for next time);
	// a destination where a file was skipped keeps its old baseline so the change is still found once that file is fixed
	for (const p of plans) {
		for (const dest of cfg.destinations) {
			if (!stats.issues.some((i) => i.rel === p.rel && isInside(dest.path, i.file))) {
				await deps.snapshots?.scope(dest.path).update(p.rel, [...p.allKeys, ...(p.removed.get(dest.path) ?? [])]);
			}
		}
	}
	return { stats, filesWithChanges };
}
