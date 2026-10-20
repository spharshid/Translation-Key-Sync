export interface Memento {
	get<T>(key: string, defaultValue: T): T;
	update(key: string, value: unknown): Thenable<void>;
}

export interface Inflight {
	root: string;
	from: string;
	to: string;
	attempts: number;
}

const MAX_ATTEMPTS = 3;
const KEY = 'inflightSyncs';
const same = (a: Inflight, b: Inflight) => a.root === b.root && a.from === b.from && a.to === b.to;

/**
 * Remembers which commits are being synced. If VS Code closes (or crashes) halfway, the entry is still here on the
 * next start and the sync is run again; re-running is harmless because it only writes the values the commit calls for.
 */
export class Journal {
	constructor(private readonly store: Memento) {}

	private read(): Inflight[] {
		return this.store.get<Inflight[]>(KEY, []);
	}

	async start(e: Omit<Inflight, 'attempts'>) {
		const list = this.read().filter((x) => !same(x, { ...e, attempts: 0 }));
		await this.store.update(KEY, [...list, { ...e, attempts: 0 }]);
	}

	async finish(e: Omit<Inflight, 'attempts'>) {
		await this.store.update(KEY, this.read().filter((x) => !same(x, { ...e, attempts: 0 })));
	}

	/** Entries to run again after a restart; each one is only retried a few times so a bad commit cannot loop forever. */
	async takeForReplay(): Promise<Inflight[]> {
		const all = this.read();
		const replay = all.filter((x) => x.attempts < MAX_ATTEMPTS);
		await this.store.update(
			KEY,
			replay.map((x) => ({ ...x, attempts: x.attempts + 1 })),
		);
		return replay;
	}
}
