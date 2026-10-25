import { isCancelled, throwIfAborted } from './cancel';
import * as fs from 'fs';
import * as path from 'path';
import { Destination, isInside, targetsOf } from './destinations';
import { changedFiles, jsonAt } from './git';
import type { PendingStore } from './pending';
import { hashValue, Snapshot, SnapshotStore } from './snapshot';
import { Change, countStrings, detectFormat, diffJson, newStats, syncFileToLocale, SyncStats, valueAt } from './sync';
import type { TranslationService } from './translation';

export interface SyncConfig {
	/** the folder with the base-language files that changes are read from */
	sourceDir: string;
	/** where changes are written (already narrowed to the ones used for this run) */
	destinations: Destination[];
	locales: string[];
	sourceLocale: string;
}

export interface Job {
	rel: string;
	changes: Change[];
	allKeys: Change[];
	format: ReturnType<typeof detectFormat>;
	sourceDoc: unknown;
}

export interface SyncDeps {
	makeService: (expectedStrings: number) => Promise<TranslationService>;
	pending?: PendingStore;
	snapshots?: SnapshotStore;
	/** aborts the sync (Stop): what was written before stays */
	signal?: AbortSignal;
}

/** Locale files that changed between two commits (from..to) under sourceDir, with their key-level changes. */
async function collectJobs(
	cfg: SyncConfig,
	gitPath: string,
	repoRoot: string,
	from: string,
	to: string,
	log: (m: string) => void,
): Promise<Job[]> {
	const relDir = path.relative(repoRoot, cfg.sourceDir).split(path.sep).join('/');
	const files = (await changedFiles(gitPath, repoRoot, from, to, relDir)).filter((f) => f.file.endsWith('.json'));
	const jobs: Job[] = [];

	for (const { status, file } of files) {
		if (status === 'D') {
			log(`skip ${file}: deleted in the source (target files are never deleted)`);
			continue;
		}
		const neu = await jsonAt(gitPath, repoRoot, to, file);
		if (neu === null) {
			log(`skip ${file}: not valid JSON in ${to.slice(0, 7)}`);
			continue;
		}
		const old = status === 'A' ? null : await jsonAt(gitPath, repoRoot, from, file);
		const changes = diffJson(old?.doc ?? null, neu.doc);
		const allKeys = diffJson(null, neu.doc);
		// a changed file whose target copy is missing still needs to be created, so don't drop it here
		const rel = file.slice(relDir.length).replace(/^\//, '');
		// With core.autocrlf the committed blob is LF while the files on disk are CRLF; new target files should match the disk.
		let formatSource = neu.raw;
		try {
			formatSource = fs.readFileSync(path.join(cfg.sourceDir, rel), 'utf8');
		} catch {
			// not on disk (e.g. syncing an older commit): the committed text is the best we have
		}
		jobs.push({ rel, changes, allKeys, format: detectFormat(formatSource), sourceDoc: neu.doc });
	}
	return jobs;
}

/** Skip keys already translated for exactly this source text (recorded in the snapshot) and present in the target. */
export function upToDateCheck(snapshot?: Snapshot) {
	return async (rel: string, c: Change, targetDoc: unknown): Promise<boolean> => {
		if (!snapshot) {
			return false;
		}
		if ((await snapshot.get(rel, c.path)) !== hashValue(c.value)) {
			return false;
		}
		const tv = valueAt(targetDoc, c.path);
		return typeof tv === 'string' ? tv.trim() !== '' : tv !== undefined;
	};
}

/** Sync every locale file changed between two commits (from..to) under sourceDir into every destination. */
export async function syncCommit(
	cfg: SyncConfig,
	deps: SyncDeps,
	gitPath: string,
	repoRoot: string,
	from: string,
	to: string,
	log: (m: string) => void,
): Promise<SyncStats> {
	const stats = newStats();
	const targetsFor = (rel: string) =>
		cfg.destinations.flatMap((dest) => targetsOf(dest, cfg.locales, cfg.sourceLocale, rel, path.join(cfg.sourceDir, rel)).map((t) => ({ ...t, dest })));
	const jobs = (await collectJobs(cfg, gitPath, repoRoot, from, to, log)).filter((j) => {
		const needed = j.changes.length > 0 || targetsFor(j.rel).some((t) => !fs.existsSync(t.file));
		if (!needed) {
			log(`${j.rel}: no key changes`);
		}
		return needed;
	});

	const expected = jobs.reduce(
		(n, j) =>
			n +
			targetsFor(j.rel)
				.filter((t) => t.locale !== cfg.sourceLocale)
				.reduce((m, t) => m + countStrings((fs.existsSync(t.file) ? j.changes : j.allKeys).map((c) => c.value)), 0),
		0,
	);
	const service = await deps.makeService(expected);
	log(`${jobs.length} file(s) to sync into ${cfg.destinations.length} destination(s), about ${expected} string(s) to translate`);

	try {
		for (const job of jobs) {
			log(`${job.rel}: ${job.changes.length} changed key(s)`);
			for (const t of targetsFor(job.rel)) {
				throwIfAborted(deps.signal);
				const ctx = { service, sourceLocale: cfg.sourceLocale, log, stats, pending: deps.pending, isUpToDate: upToDateCheck(deps.snapshots?.scope(t.dest.path)) };
				await syncFileToLocale(ctx, {
					rel: job.rel,
					targetFile: t.file,
					changes: job.changes,
					allKeys: job.allKeys,
					sourceFormat: job.format,
					sourceDoc: job.sourceDoc,
					locale: t.locale,
				});
			}
			// every key of this file is now synced from its current text (not into a destination where a file was skipped: it still needs this change)
			for (const dest of cfg.destinations) {
				if (!stats.issues.some((i) => i.rel === job.rel && isInside(dest.path, i.file))) {
					await deps.snapshots?.scope(dest.path).update(job.rel, [...job.allKeys, ...job.changes.filter((c) => c.deleted)]);
				}
			}
		}
	} catch (e) {
		if (!isCancelled(e)) {
			throw e;
		}
		stats.cancelled = true;
		log('stopped by the user');
	}
	return stats;
}
