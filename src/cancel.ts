/** Raised when the user stops the work in progress. Nothing half-done is written when it is thrown. */
export class Cancelled extends Error {
	constructor() {
		super('stopped by the user');
		this.name = 'Cancelled';
	}
}

export const isCancelled = (e: unknown): e is Cancelled => e instanceof Error && e.name === 'Cancelled';

export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new Cancelled();
	}
}

/** A wait that ends early, by throwing Cancelled, when the signal aborts. */
export async function waitUnlessAborted(sleep: (ms: number) => Promise<void>, ms: number, signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	if (!signal) {
		return sleep(ms);
	}
	let onAbort: () => void = () => undefined;
	const aborted = new Promise<never>((_, reject) => {
		onAbort = () => reject(new Cancelled());
		signal.addEventListener('abort', onAbort, { once: true });
	});
	try {
		await Promise.race([sleep(ms), aborted]);
	} finally {
		signal.removeEventListener('abort', onAbort);
	}
}
