import * as fs from 'fs';
import * as path from 'path';
import { changedFiles, jsonAt } from './git';
import type { PendingStore } from './pending';
import { Change, countStrings, detectFormat, diffJson, syncFileToLocale, SyncStats } from './sync';
import { Translator } from './translator';

export interface SyncConfig {
	sourceDir: string;
	targetDir: string;
	locales: string[];
	sourceLocale: string;
}

interface Job {
	rel: string;
	changes: Change[];
	allKeys: Change[];
	format: ReturnType<typeof detectFormat>;
}

/** Locale files that changed between two commits (from..to) under sourceDir, with their key-level changes. */
export async function collectJobs(
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
		jobs.push({ rel, changes, allKeys, format: detectFormat(formatSource) });
	}
	return jobs;
}

/** Sync every locale file changed between two commits (from..to) under sourceDir. */
export async function syncCommit(
	cfg: SyncConfig,
	deps: { makeTranslator: (expectedStrings: number) => Translator; pending?: PendingStore },
	gitPath: string,
	repoRoot: string,
	from: string,
	to: string,
	log: (m: string) => void,
): Promise<SyncStats> {
	const stats: SyncStats = { written: 0, files: 0, pending: 0, created: 0, verified: 0 };
	const jobs = (await collectJobs(cfg, gitPath, repoRoot, from, to, log)).filter((j) => {
		const needed =
			j.changes.length > 0 ||
			cfg.locales.some((l) => !fs.existsSync(path.join(cfg.targetDir, l, j.rel)));
		if (!needed) {
			log(`${j.rel}: no key changes`);
		}
		return needed;
	});

	const targets = cfg.locales.filter((l) => l !== cfg.sourceLocale);
	const expected = jobs.reduce((n, j) => {
		return (
			n +
			targets.reduce((m, l) => {
				const missing = !fs.existsSync(path.join(cfg.targetDir, l, j.rel));
				return m + countStrings((missing ? j.allKeys : j.changes).map((c) => c.value));
			}, 0)
		);
	}, 0);
	const translator = deps.makeTranslator(expected);
	await translator.prepare();
	log(`${jobs.length} file(s) to sync, about ${expected} string(s) to translate`);

	for (const job of jobs) {
		log(`${job.rel}: ${job.changes.length} changed key(s)`);
		for (const locale of cfg.locales) {
			await syncFileToLocale(
				{ translator, log, stats, pending: deps.pending },
				path.join(cfg.targetDir, locale, job.rel),
				job.changes,
				job.allKeys,
				job.format,
				locale,
			);
		}
	}
	return stats;
}
