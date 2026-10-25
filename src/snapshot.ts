import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { KeyPath } from './sync';

export const hashValue = (v: unknown): string =>
	crypto.createHash('sha1').update(JSON.stringify(v) ?? 'undefined').digest('hex').slice(0, 16);

type Data = Record<string, Record<string, Record<string, string>>>;

/** What one destination remembers: the source-language value each of its keys was last synced from. */
export interface Snapshot {
	/** hash recorded for a key of a file, if any */
	get(rel: string, p: KeyPath): Promise<string | undefined>;
	/** every recorded key of a file */
	keysOf(rel: string): Promise<{ path: KeyPath; hash: string }[]>;
	/** record (value given) or forget (deleted) keys, then persist */
	update(rel: string, entries: { path: KeyPath; value?: unknown; deleted?: boolean }[]): Promise<void>;
}

/**
 * Remembers, per destination folder, which source-language value every key was last synced from.
 * That lets a sync recognise "this key is already translated for this exact text" (so nothing is translated twice,
 * and a change made in one repo is not redone when the same change arrives from the other) and
 * "this key was removed since last time" without guessing. Each destination has its own baseline, so syncing to one
 * destination today and another tomorrow never makes either of them miss a change.
 *
 * It is stored per developer in the extension's private storage; it is a cache, never required for correctness:
 * with no entry a key is simply treated as unknown. One instance owns the file; destinations get a view with `scope`.
 */
export class SnapshotStore {
	private data: Data | null = null;
	private lock: Promise<unknown> = Promise.resolve();

	constructor(private readonly file: string) {}

	private async load(): Promise<Data> {
		if (this.data === null) {
			try {
				this.data = JSON.parse(await fs.readFile(this.file, 'utf8'));
			} catch {
				this.data = {};
			}
		}
		return this.data!;
	}

	private exclusive<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.lock.then(fn, fn);
		this.lock = run.catch(() => undefined);
		return run;
	}

	/** The baseline of one destination folder. */
	scope(dir: string): Snapshot {
		const key = path.resolve(dir).toLowerCase();
		const files = async () => ((await this.load())[key] ??= {});
		return {
			get: (rel, p) => this.exclusive(async () => (await files())[rel]?.[JSON.stringify(p)]),
			keysOf: (rel) =>
				this.exclusive(async () => Object.entries((await files())[rel] ?? {}).map(([k, hash]) => ({ path: JSON.parse(k) as KeyPath, hash }))),
			update: (rel, entries) =>
				this.exclusive(async () => {
					const f = ((await files())[rel] ??= {});
					for (const e of entries) {
						const k = JSON.stringify(e.path);
						if (e.deleted) {
							delete f[k];
						} else {
							f[k] = hashValue(e.value);
						}
					}
					await fs.mkdir(path.dirname(this.file), { recursive: true });
					await fs.writeFile(this.file, JSON.stringify(this.data), 'utf8');
				}),
		};
	}
}
