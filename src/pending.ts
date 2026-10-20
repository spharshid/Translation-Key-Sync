import * as fs from 'fs/promises';
import { applyEdits, modify, parse } from 'jsonc-parser';
import { detectFormat, KeyPath } from './sync';
import { Translator } from './translator';

/** A string that was written to a locale file in English because no provider could translate it in time. */
export interface PendingEntry {
	file: string;
	path: KeyPath;
	/** the English text that was written as a placeholder */
	text: string;
	locale: string;
	since: number;
}

const same = (a: PendingEntry, b: PendingEntry) => a.file === b.file && JSON.stringify(a.path) === JSON.stringify(b.path);

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
		await fs.mkdir(this.file.replace(/[\\/][^\\/]*$/, ''), { recursive: true });
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

/**
 * Try again for every pending string. A string is only replaced if the file still holds the English placeholder we
 * wrote; if someone has edited or removed it since, the entry is just dropped.
 */
export async function retryPending(
	store: PendingStore,
	translator: Translator,
	log: (m: string) => void,
): Promise<{ fixed: number; dropped: number; remaining: number }> {
	const entries = await store.all();
	let fixed = 0;
	let dropped = 0;
	const finished: PendingEntry[] = [];

	const byFile = new Map<string, PendingEntry[]>();
	for (const e of entries) {
		byFile.set(e.file, [...(byFile.get(e.file) ?? []), e]);
	}

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
		let updated = raw;
		for (const e of list) {
			if (valueAt(parse(updated), e.path) !== e.text) {
				dropped++; // changed by someone else (or removed): leave it alone
				finished.push(e);
				continue;
			}
			const r = await translator.translate(e.text, e.locale);
			if (r.fellBack) {
				continue; // still not possible, stays queued
			}
			updated = applyEdits(
				updated,
				modify(updated, e.path, r.value, {
					formattingOptions: { eol: fmt.eol, insertSpaces: fmt.insertSpaces, tabSize: fmt.tabSize },
				}),
			);
			fixed++;
			finished.push(e);
			log(`[${e.locale}] translated pending ${e.path.join('.')} in ${file}`);
		}
		if (updated !== raw) {
			await fs.writeFile(file, bom + updated, 'utf8');
		}
	}
	await store.remove(finished);
	return { fixed, dropped, remaining: entries.length - finished.length };
}
