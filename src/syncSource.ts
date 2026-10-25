import { isCancelled, throwIfAborted } from './cancel';
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

/**
 * What a sync looks at:
 *  changes  only the keys that differ between the last commit and the files as they are now (staged or not) in the source's repo
 *  all      the whole files: every key that is missing from a destination, or was edited since the destination last synced it
 */
export type SyncScope = 'changes' | 'all';

export interface SourceSyncResult {
	stats: SyncStats;
	/** source files that had something to write somewhere */
	filesWithChanges: number;
	/** source files that had changes since the last commit (always every file in "all" mode) */
	changedFiles: number;
	/** "changes" was asked for but the source is not in a git repository, so whole files were compared */
	fellBack: boolean;
	/** the user stopped the sync before it was done: what was written before stays, the rest was not touched */
	cancelled: boolean;
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

/**
 * The keys of a source file that differ from the last commit: added, changed and removed, whether the edit is staged or not
 * (the working copy contains both). A file that is not in the last commit yet counts as all new. undefined = the file is not in a
 * git repository, so changes cannot be told apart.
 */
async function changesSinceHead(gitPath: string, file: string, nowDoc: unknown): Promise<Change[] | undefined> {
	let root: string;
	try {
		root = (await git(gitPath, path.dirname(file), ['rev-parse', '--show-toplevel'])).trim();
	} catch {
		return undefined;
	}
	const rel = path.relative(root, file).split(path.sep).join('/');
	const head = await jsonAt(gitPath, root, 'HEAD', rel);
	return diffJson(head?.doc ?? null, nowDoc);
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
	scope: SyncScope;
	srcRaw: string;
	srcDoc: unknown;
	allKeys: Change[];
	/** "changes" scope: the keys that differ from the last commit */
	changed: Change[];
	/** "all" scope: keys that were removed from the source since a destination last synced, per destination */
	removed: Map<string, Change[]>;
	targets: Target[];
}

/**
 * What every source file asks of every destination. Nothing is written. Files that are not valid JSON, and keys whose place
 * in a target file clashes with the source, are not planned; they are reported in `issues` instead.
 */
async function planSource(
	cfg: SyncConfig,
	deps: Pick<SyncDeps, 'snapshots'>,
	gitPath: string,
	log: (m: string) => void,
	issues: Issue[],
	scope: SyncScope,
): Promise<{ plans: Plan[]; fellBack: boolean }> {
	const files = await listJson(cfg.sourceDir);
	if (!files.length) {
		log(`no .json files found in ${cfg.sourceDir}`);
	}

	const plans: Plan[] = [];
	let fellBack = false;
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

		let fileScope: SyncScope = scope;
		let changed: Change[] = [];
		if (scope === 'changes') {
			const c = await changesSinceHead(gitPath, srcFile, src.doc);
			if (c === undefined) {
				fileScope = 'all'; // not in a git repo: there is no "last commit" to compare with
				fellBack = true;
			} else if (!c.length) {
				continue; // nothing changed in this file since the last commit
			} else {
				changed = c;
			}
		}
		const present = new Set(allKeys.map((c) => JSON.stringify(c.path)));
		const uncommitted = fileScope === 'all' ? await uncommittedChanges(gitPath, srcFile) : [];
		const wanted = changed.filter((c) => !c.deleted);
		const gone = changed.filter((c) => c.deleted);

		const removedBy = new Map<string, Change[]>();
		const targets: Target[] = [];
		for (const dest of cfg.destinations) {
			// "all": edited since this destination was last synced, from its snapshot (hash differs) and from uncommitted edits (vs HEAD)
			const edited = new Map<string, Change>();
			const removed = new Map<string, Change>();
			if (fileScope === 'all') {
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
			}
			removedBy.set(dest.path, [...removed.values()]);

			for (const { locale, file } of targetsOf(dest, cfg.locales, cfg.sourceLocale, rel, srcFile)) {
				const t = await readJson(file);
				const changes: Change[] = [];
				const detail: Detail = { fileMissing: !t, missing: [], outdated: [] };
				const broken = t ? jsonProblem(t.raw) : undefined;
				if (broken) {
					addIssue(issues, { file, rel, locale, kind: 'invalid-json', message: broken.message, line: broken.line });
				} else if (fileScope === 'changes') {
					// only the keys that changed since the last commit, wherever they are missing or already translated
					for (const c of wanted) {
						const clash = t ? structureProblem(t.doc, c.path) : undefined;
						if (clash) {
							addIssue(issues, { file, rel, locale, kind: 'structure', message: clash, key: dottedPath(c.path) });
							continue;
						}
						changes.push(c);
						(t && valueAt(t.doc, c.path) !== undefined ? detail.outdated : detail.missing).push(dottedPath(c.path));
					}
					for (const c of gone) {
						if (t && valueAt(t.doc, c.path) !== undefined) {
							changes.push(c);
						}
					}
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
		plans.push({ rel, scope: fileScope, srcRaw: src.raw, srcDoc: src.doc, allKeys, changed, removed: removedBy, targets });
	}
	return { plans, fellBack };
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

/** A dry run of "Sync All Missing": what is not synced yet anywhere and what is broken, without writing anything. */
export async function scanSource(cfg: SyncConfig, deps: Pick<SyncDeps, 'snapshots'>, gitPath: string, log: (m: string) => void): Promise<ScanResult> {
	const issues: Issue[] = [];
	const { plans } = await planSource(cfg, deps, gitPath, log, issues, 'all');
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
 * Sync the source folder to the destinations: translated into the "translate" destinations, copied as it is into the "copy"
 * destinations.
 *  "changes" (the default, the Sync Locales button) handles only the keys that differ from the last commit of the source's repo, so
 *  an unrelated key that happens to be missing somewhere is left alone. A target file that does not exist yet is created with
 *  just those keys.
 *  "all" compares the whole files and brings across everything missing or edited. What counts as edited is judged per
 *  destination, so a destination that was left out of an earlier run still receives those changes the next time it is included.
 */
export async function syncFromSource(cfg: SyncConfig, deps: SyncDeps, gitPath: string, log: (m: string) => void, scope: SyncScope = 'changes'): Promise<SourceSyncResult> {
	const stats = newStats();
	const { plans, fellBack } = await planSource(cfg, deps, gitPath, log, stats.issues, scope);
	if (fellBack) {
		log('the source folder is not in a git repository, so changes cannot be told apart: whole files are compared instead');
	}

	const needs = (p: Plan, t: Target) => t.changes.length > 0 || (p.scope === 'all' && !existsSync(t.file));
	const work = plans.filter((p) => p.targets.some((t) => needs(p, t)));
	const expected = work.reduce(
		(n, p) =>
			n +
			p.targets
				.filter((t) => t.locale !== cfg.sourceLocale)
				.reduce((m, t) => m + countStrings((p.scope === 'all' && !existsSync(t.file) ? p.allKeys : t.changes).map((x) => x.value)), 0),
		0,
	);
	const service = await deps.makeService(expected);
	log(`${work.length} file(s) to ${scope === 'changes' ? 'sync' : 'check'} in ${cfg.destinations.length} destination(s), about ${expected} string(s) to translate`);

	let filesWithChanges = 0;
	let cancelled = false;
	try {
		for (const p of work) {
			const format = detectFormat(p.srcRaw);
			let touched = false;
			for (const t of p.targets) {
				throwIfAborted(deps.signal);
				if (!needs(p, t)) {
					continue;
				}
				touched = true;
				const ctx = { service, sourceLocale: cfg.sourceLocale, log, stats, pending: deps.pending, isUpToDate: upToDateCheck(deps.snapshots?.scope(t.dest.path)) };
				await syncFileToLocale(ctx, { rel: p.rel, targetFile: t.file, changes: t.changes, allKeys: p.allKeys, sourceFormat: format, sourceDoc: p.srcDoc, locale: t.locale, onlyChanges: p.scope === 'changes' });
			}
			if (touched) {
				filesWithChanges++;
			}
		}
		// Remember what the keys were synced from. After a whole-file run that is every key (also for files that needed nothing now: the
		// baseline for next time); after a changes-only run it is just the keys that were handled, because the others were not looked at.
		// A destination where a file was skipped keeps its old baseline so the change is still found once that file is fixed.
		for (const p of plans) {
			for (const dest of cfg.destinations) {
				if (!stats.issues.some((i) => i.rel === p.rel && isInside(dest.path, i.file))) {
					const entries = p.scope === 'all' ? [...p.allKeys, ...(p.removed.get(dest.path) ?? [])] : p.changed;
					await deps.snapshots?.scope(dest.path).update(p.rel, entries);
				}
			}
		}
	} catch (e) {
		if (!isCancelled(e)) {
			throw e;
		}
		cancelled = true; // the baselines are not updated: they would claim keys that were never synced
		log('stopped by the user');
	}
	return { stats, filesWithChanges, changedFiles: plans.length, fellBack, cancelled };
}
