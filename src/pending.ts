import { isCancelled } from './cancel';
import * as fs from 'fs/promises';
import * as path from 'path';
import { applyEdits, modify, parse } from 'jsonc-parser';
import { dottedPath } from './ai/refs';
import { detectFormat, KeyPath } from './sync';
import type { TranslationService } from './translation';

/**
 * A string that is not in its final state yet:
 *  english  no translator worked in time, the English text was written as a placeholder
 *  lowconf  only machine translation was available; it was written, and an AI model should redo it when it can
 */
export interface PendingEntry {
	file: string;
	path: KeyPath;
	/** the source-language text */
	text: string;
	locale: string;
	since: number;
	kind?: 'english' | 'lowconf';
	/** the value we wrote; the entry only applies while the file still holds exactly this */
	written?: string;
}

const same = (a: PendingEntry, b: PendingEntry) => a.file === b.file && JSON.stringify(a.path) === JSON.stringify(b.path);
export const writtenOf = (e: PendingEntry) => e.written ?? e.text;

/** Small JSON-file-backed list, kept in the extension's global storage so it survives restarts. */
export class PendingStore {
	private list: PendingEntry[] | null = null;
	private lock: Promise<unknown> = Promise.resolve();

	constructor(private readonly file: string) {}

	private async load(): Promise<PendingEntry[]> {
		if (this.list === null) {
			try {
				this.list = JSON.parse(await fs.readFile(this.file, 'utf8'));
			} catch {
				this.list = [];
			}
		}
		return this.list!;
	}

	private async save() {
		await fs.mkdir(path.dirname(this.file), { recursive: true });
		await fs.writeFile(this.file, JSON.stringify(this.list, null, 2), 'utf8');
	}

	private exclusive<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.lock.then(fn, fn);
		this.lock = run.catch(() => undefined);
		return run;
	}

	add(entries: PendingEntry[]) {
		return this.exclusive(async () => {
			const list = await this.load();
			for (const e of entries) {
				const i = list.findIndex((x) => same(x, e));
				if (i >= 0) {
					list[i] = e;
				} else {
					list.push(e);
				}
			}
			await this.save();
		});
	}

	all(): Promise<PendingEntry[]> {
		return this.exclusive(async () => [...(await this.load())]);
	}

	remove(entries: PendingEntry[]) {
		return this.exclusive(async () => {
			const list = await this.load();
			this.list = list.filter((x) => !entries.some((e) => same(x, e)));
			await this.save();
		});
	}

	async count() {
		return (await this.all()).length;
	}
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

export interface RetryResult {
	fixed: number;
	dropped: number;
	remaining: number;
}

/**
 * Try again for every queued string.
 *  - A string is only touched while the file still holds exactly what we wrote; if someone has edited or removed it
 *    since, the entry is dropped and their text is left alone.
 *  - "english" entries accept any translation (the AI result is final; a machine result is better than English but
 *    stays queued for an AI redo).
 *  - "lowconf" entries are only replaced by an AI result.
 */
export async function retryPending(store: PendingStore, service: TranslationService, log: (m: string) => void): Promise<RetryResult> {
	const entries = await store.all();
	let fixed = 0;
	let dropped = 0;
	const finished: PendingEntry[] = [];
	const updated: PendingEntry[] = [];

	const byFile = new Map<string, PendingEntry[]>();
	for (const e of entries) {
		byFile.set(e.file, [...(byFile.get(e.file) ?? []), e]);
	}

	try {
		for (const [file, list] of byFile) {
			let raw: string;
			try {
				raw = await fs.readFile(file, 'utf8');
			} catch {
				dropped += list.length; // the file is gone
				finished.push(...list);
				continue;
			}
			let bom = '';
			if (raw.startsWith('﻿')) {
				bom = '﻿';
				raw = raw.slice(1);
			}
			const fmt = detectFormat(raw);
			const doc = parse(raw);

			const live: PendingEntry[] = [];
			for (const e of list) {
				if (valueAt(doc, e.path) !== writtenOf(e)) {
					dropped++; // changed by someone else (or removed): leave it alone
					finished.push(e);
				} else {
					live.push(e);
				}
			}

			let text = raw;
			for (const locale of new Set(live.map((e) => e.locale))) {
				const group = live.filter((e) => e.locale === locale);
				const aiOnly = group.every((e) => e.kind === 'lowconf');
				if (aiOnly && !service.aiAvailable) {
					continue; // nothing could improve these right now
				}
				const items = group.map((e, i) => ({ id: `p${i}`, text: e.text, keyPath: dottedPath(e.path) }));
				const res = await service.translateBatch({ locale, file: path.basename(file), items, refs: [], aiOnly });
				for (const [i, e] of group.entries()) {
					const r = res.get(`p${i}`);
					if (!r || r.origin === 'english') {
						continue; // still not possible, stays queued
					}
					if (r.origin === 'classic' && e.kind === 'lowconf') {
						continue;
					}
					text = applyEdits(
						text,
						modify(text, e.path, r.value, { formattingOptions: { eol: fmt.eol, insertSpaces: fmt.insertSpaces, tabSize: fmt.tabSize } }),
					);
					log(`[${locale}] translated pending ${dottedPath(e.path)} in ${path.basename(file)} (${r.origin})`);
					if (r.origin === 'ai') {
						fixed++;
						finished.push(e);
					} else if (service.aiIntended) {
						updated.push({ ...e, kind: 'lowconf', written: r.value }); // better than English, still queued for the AI
					} else {
						fixed++;
						finished.push(e);
					}
				}
			}
			if (text !== raw) {
				await fs.writeFile(file, bom + text, 'utf8');
			}
		}
	} catch (e) {
		if (!isCancelled(e)) {
			throw e;
		}
		log('stopped by the user: what was finished stays, the rest is still queued');
	}
	await store.remove(finished);
	if (updated.length) {
		await store.add(updated);
	}
	return { fixed, dropped, remaining: entries.length - finished.length };
}
