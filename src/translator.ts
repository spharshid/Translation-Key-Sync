import { protect, restore } from './placeholders';

export type Provider = 'auto' | 'backend' | 'google';

export interface Timing {
	/** wait after an ordinary Google failure; doubles each time */
	googleBackoffBaseMs: number;
	googleBackoffMaxMs: number;
	/** wait after Google answered with "blocked / automated queries"; doubles each time */
	googleBlockBaseMs: number;
	googleBlockMaxMs: number;
	/** an endpoint that answered "blocked" is not tried again for this long */
	googleEndpointBlockMs: number;
	/** minimum time between two Google requests (be a polite, human-paced client) */
	googleMinIntervalMs: number;
	/** how long a run waits at start for a sleeping backend before carrying on with Google */
	wakeProbeMs: number;
	/** one wake-up request may take this long (cold container + model load) */
	wakeRequestTimeoutMs: number;
	wakeRetryMs: number;
	/** stop trying to wake the backend after this long */
	wakeGiveUpMs: number;
	/** how often to re-check when every provider is unavailable */
	pollMs: number;
}

const DEFAULT_TIMING: Timing = {
	googleBackoffBaseMs: 1000,
	googleBackoffMaxMs: 60_000,
	googleBlockBaseMs: 30_000,
	googleBlockMaxMs: 10 * 60_000,
	googleEndpointBlockMs: 10 * 60_000,
	googleMinIntervalMs: 700,
	wakeProbeMs: 8000,
	wakeRequestTimeoutMs: 5 * 60_000,
	wakeRetryMs: 15_000,
	wakeGiveUpMs: 15 * 60_000,
	pollMs: 500,
};

export interface TranslatorOptions {
	/** the user stopped the run: loops end as if the time budget was spent (the caller then raises Cancelled) */
	signal?: AbortSignal;
	backendUrl: string;
	/** override the Google endpoint (corporate proxy); empty = the built-in endpoints */
	googleUrl?: string;
	/** several endpoints, tried in order (tests); wins over googleUrl */
	googleEndpoints?: string[];
	backendTimeoutMs: number;
	provider: Provider;
	/** kept for compatibility: how many strings this run will translate */
	expectedStrings: number;
	/** after this long the run stops waiting and leaves the remaining strings to the pending queue */
	budgetMs?: number;
	timing?: Partial<Timing>;
	log: (msg: string) => void;
	onTranslated?: () => void;
}

const DEFAULT_BUDGET_MS = 5 * 60_000;
/**
 * Google's unofficial endpoints. The "clients5" one (what Chrome's dictionary extension uses) kept answering in testing while
 * the commonly used "gtx" one was blocked for automated use, so it goes first. Either may be blocked or withdrawn at any time.
 */
const GOOGLE_CLIENTS5 = 'https://clients5.google.com/translate_a/t';
const GOOGLE_GTX = 'https://translate.googleapis.com/translate_a/single';
const BROWSER_HEADERS = {
	'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
	'Accept-Language': 'en-US,en;q=0.9',
};
// the Space truncates at 128 tokens, so send it short chunks; Google takes a URL, so keep that short too
const BACKEND_CHUNK = 220;
const GOOGLE_CHUNK = 1200;
const BATCH_LINES = 20;

class SkippedError extends Error {}
class UnsupportedError extends Error {}
/** Google answered with a captcha / "automated queries" page or 429/403. */
export class GoogleBlocked extends Error {}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Split long text at sentence ends (or whitespace) into pieces of at most `max` characters. */
export function chunkText(text: string, max: number): string[] {
	if (text.length <= max) {
		return [text];
	}
	const pieces: string[] = [];
	for (const sentence of text.split(/(?<=[.!?。؟])\s+/)) {
		let rest = sentence;
		while (rest.length > max) {
			let cut = rest.lastIndexOf(' ', max);
			if (cut < max / 2) {
				cut = max; // no usable space: hard cut
			}
			pieces.push(rest.slice(0, cut));
			rest = rest.slice(cut).trimStart();
		}
		pieces.push(rest);
	}
	const chunks: string[] = [];
	for (const p of pieces) {
		const last = chunks.length - 1;
		if (last >= 0 && chunks[last].length + 1 + p.length <= max) {
			chunks[last] += ' ' + p;
		} else {
			chunks.push(p);
		}
	}
	return chunks;
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<any> {
	const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
	if (!res.ok) {
		throw new Error(`HTTP ${res.status}`);
	}
	// a sleeping Space answers with an HTML page: that throws here and counts as a failure
	return res.json();
}

async function viaBackend(text: string, lang: string, source: string, base: string, timeoutMs: number): Promise<string> {
	const data = await fetchJson(
		`${base.replace(/\/$/, '')}/translate`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			// `source` is ignored by older versions of the Space; newer ones skip language detection with it
			body: JSON.stringify({ text, lang, source }),
		},
		timeoutMs,
	);
	if (typeof data?.translated !== 'string') {
		const msg = String(data?.error ?? 'bad response');
		throw msg.startsWith('Unsupported language') ? new UnsupportedError(msg) : new Error(msg);
	}
	return data.translated;
}

/** Request URL for either flavour of Google endpoint (the "/translate_a/t" one is the Chrome-extension style). */
export function googleRequestUrl(base: string, text: string, lang: string, sl: string): string {
	const q = encodeURIComponent(text);
	const to = encodeURIComponent(lang);
	const from = encodeURIComponent(sl);
	return /\/translate_a\/t(\?|$)/.test(base)
		? `${base}?client=dict-chrome-ex&sl=${from}&tl=${to}&q=${q}`
		: `${base}?client=gtx&sl=${from}&tl=${to}&dt=t&q=${q}`;
}

/** Text out of either answer shape: ["text"] / [["text","src"]] (Chrome style) or [[["seg","src"],...],...] (gtx). */
export function parseGoogle(data: unknown): string {
	if (Array.isArray(data)) {
		const first = data[0];
		if (typeof first === 'string') {
			return first;
		}
		if (Array.isArray(first)) {
			if (Array.isArray(first[0])) {
				return (first as unknown[][]).map((seg) => String(seg[0] ?? '')).join('');
			}
			if (typeof first[0] === 'string') {
				return first[0];
			}
		}
	}
	throw new Error('bad response');
}

/** The Space returns 'Uno  Uno' / 'Cancel  Cancel' for very short strings. */
function repeatedParts(source: string, result: string): string[] | null {
	// a one-word source can't legitimately become "X x", so any spacing counts; otherwise require 2+ spaces
	const parts = result.trim().split(/\s+/.test(source.trim()) ? / {2,}/ : / +/);
	const first = parts[0].toLowerCase();
	return parts.length > 1 && parts.every((p) => p.toLowerCase() === first) ? parts : null;
}
function cleanBackend(source: string, result: string): string {
	return repeatedParts(source, result)?.[0] ?? result;
}

const words = (s: string) => s.toLowerCase().match(/\p{L}{3,}/gu) ?? [];

/** Backend answers that look like "not actually translated": same text, repeated text, or mostly the source words. */
function looksSuspect(source: string, result: string): boolean {
	if (repeatedParts(source, result) !== null || result.trim().toLowerCase() === source.trim().toLowerCase()) {
		return true;
	}
	const src = words(source);
	if (src.length < 2) {
		return false;
	}
	const res = new Set(words(result));
	return src.filter((w) => res.has(w)).length / src.length >= 0.6;
}

/**
 * What we currently know about each provider. Shared between runs so that a backend we already woke up
 * (or a Google that is rate limiting us) is remembered.
 */
export class ProviderHealth {
	backendReady = false;
	wake: Promise<void> | null = null;
	googleFails = 0;
	googleBlocks = 0;
	googleCooldownUntil = 0;
	googleLastAt = 0;
	/** Google endpoints that answered "blocked", and until when they are skipped */
	readonly googleBlocked = new Map<string, number>();
	readonly unsupported = new Set<string>(); // target languages the backend does not offer
}

interface Prov {
	name: 'backend' | 'google';
	available: () => boolean;
	run: () => Promise<string>;
	ok: () => void;
	fail: (e: Error) => void;
}

export interface MachineResult {
	value: string;
	fellBack: boolean;
}

export class Translator {
	private readonly cache = new Map<string, string>();
	private backendLane: Promise<unknown> = Promise.resolve(); // the Space handles one request at a time
	private googleLane: Promise<unknown> = Promise.resolve(); // Google requests go one at a time, human-paced
	private readonly t: Timing;
	private readonly deadline: number;
	private readonly googleEndpoints: string[];
	private announcedWake = false;

	/** the time budget is spent, or the user stopped the run */
	private get over(): boolean {
		return Date.now() >= this.deadline || !!this.o.signal?.aborted;
	}

	constructor(
		private readonly o: TranslatorOptions,
		private readonly sourceLocale: string,
		private readonly h: ProviderHealth = new ProviderHealth(),
	) {
		this.t = { ...DEFAULT_TIMING, ...o.timing };
		this.deadline = Date.now() + (o.budgetMs ?? DEFAULT_BUDGET_MS);
		this.googleEndpoints = o.googleEndpoints ?? (o.googleUrl ? [o.googleUrl] : [GOOGLE_CLIENTS5, GOOGLE_GTX]);
	}

	/** Call once before translating. Google needs no preparation; the Space is only woken when it is the chosen provider. */
	async prepare(): Promise<void> {
		if (this.o.provider !== 'backend') {
			return;
		}
		this.ensureWake();
		if (this.h.wake) {
			await Promise.race([this.h.wake, sleep(this.t.wakeProbeMs)]);
		}
	}

	/** Keep poking a cold backend (container start + model load can take minutes) without blocking anyone. */
	private ensureWake() {
		if (this.o.provider === 'google' || this.h.backendReady || this.h.wake) {
			return;
		}
		const giveUp = Date.now() + this.t.wakeGiveUpMs;
		this.h.wake = (async () => {
			while (!this.h.backendReady && Date.now() < giveUp) {
				try {
					await viaBackend('Hello', 'es', this.sourceLocale, this.o.backendUrl, this.t.wakeRequestTimeoutMs);
					this.h.backendReady = true;
					this.o.log('backend is awake and ready');
				} catch (e) {
					await sleep(this.t.wakeRetryMs);
					this.o.log(`backend still not ready (${(e as Error).message}); waiting`);
				}
			}
		})().finally(() => {
			this.h.wake = null;
		});
	}

	private lane<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.backendLane.then(fn, fn);
		this.backendLane = run.catch(() => undefined);
		return run;
	}

	/** One Google request at a time, never closer together than the minimum interval. */
	private gated<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.googleLane.then(async () => {
			const wait = this.h.googleLastAt + this.t.googleMinIntervalMs - Date.now();
			if (wait > 0) {
				await sleep(wait);
			}
			this.h.googleLastAt = Date.now();
			return fn();
		});
		this.googleLane = run.catch(() => undefined);
		return run;
	}

	private googleAvailable() {
		return this.o.provider !== 'backend' && Date.now() >= this.h.googleCooldownUntil;
	}

	private googleOk() {
		this.h.googleFails = 0;
		this.h.googleBlocks = 0;
		this.h.googleCooldownUntil = 0;
	}

	private googleFail(e: Error) {
		const h = this.h;
		let wait: number;
		if (e instanceof GoogleBlocked) {
			h.googleBlocks++;
			wait = Math.min(this.t.googleBlockBaseMs * 2 ** (h.googleBlocks - 1), this.t.googleBlockMaxMs);
		} else {
			h.googleFails++;
			wait = Math.min(this.t.googleBackoffBaseMs * 2 ** (h.googleFails - 1), this.t.googleBackoffMaxMs);
		}
		h.googleCooldownUntil = Date.now() + wait;
	}

	/** One Google call, trying each endpoint that is not currently known to be blocked. */
	private async googleOne(text: string, lang: string): Promise<string> {
		let lastError: Error | undefined;
		let tried = 0;
		for (const base of this.googleEndpoints) {
			if ((this.h.googleBlocked.get(base) ?? 0) > Date.now()) {
				continue;
			}
			tried++;
			try {
				const res = await fetch(googleRequestUrl(base, text, lang, this.sourceLocale), {
					headers: BROWSER_HEADERS,
					signal: AbortSignal.timeout(20_000),
				});
				if (res.status === 429 || res.status === 403) {
					throw new GoogleBlocked(`HTTP ${res.status}`);
				}
				if (!res.ok) {
					throw new Error(`HTTP ${res.status}`);
				}
				let data: unknown;
				try {
					data = JSON.parse(await res.text());
				} catch {
					throw new GoogleBlocked('an HTML page instead of a translation (blocked)');
				}
				return parseGoogle(data);
			} catch (e) {
				lastError = e as Error;
				if (e instanceof GoogleBlocked) {
					this.h.googleBlocked.set(base, Date.now() + this.t.googleEndpointBlockMs);
					this.o.log(`Google endpoint ${new URL(base).host}${new URL(base).pathname} is blocking requests; trying the next one`);
				}
			}
		}
		throw tried === 0 ? new GoogleBlocked('every Google endpoint is blocked right now') : lastError!;
	}

	private googleFirst() {
		return this.o.provider !== 'backend';
	}

	/** Translate one string; multi-line strings are translated line by line so the line breaks survive. */
	async translate(text: string, lang: string): Promise<MachineResult> {
		if (!text.trim() || lang === this.sourceLocale) {
			return { value: text, fellBack: false };
		}
		if (!/\r?\n/.test(text)) {
			return this.translateLine(text, lang);
		}
		const parts = text.split(/(\r?\n)/);
		for (let i = 0; i < parts.length; i += 2) {
			if (parts[i].trim()) {
				const r = await this.translateLine(parts[i], lang);
				if (r.fellBack) {
					// all or nothing, so the pending queue can recognise the untouched English value later
					return { value: text, fellBack: true };
				}
				parts[i] = r.value;
			}
		}
		return { value: parts.join(''), fellBack: false };
	}

	/**
	 * Translate many strings at once. Single-line strings are packed into a few Google requests (one request carries up to 20
	 * lines, one per line), which is what keeps a whole commit well under any per-IP limit. Anything that does not come back
	 * cleanly (line count mismatch, damaged placeholder, Google unavailable) is translated individually by `translate`.
	 */
	async translateMany(texts: string[], lang: string): Promise<MachineResult[]> {
		const results: (MachineResult | undefined)[] = new Array(texts.length).fill(undefined);
		const batchable: number[] = [];
		texts.forEach((t, i) => {
			if (!t.trim() || lang === this.sourceLocale) {
				results[i] = { value: t, fellBack: false };
			} else if (!/\r?\n/.test(t)) {
				const hit = this.cache.get(`${lang}\u0000${t}`);
				if (hit !== undefined) {
					results[i] = { value: hit, fellBack: false };
				} else {
					batchable.push(i);
				}
			}
		});

		if (this.googleAvailable()) {
			const masked = new Map<number, ReturnType<typeof protect>>();
			for (const i of batchable) {
				masked.set(i, protect(texts[i]));
			}
			// group into requests of limited size
			const groups: number[][] = [];
			let cur: number[] = [];
			let size = 0;
			for (const i of batchable) {
				const len = masked.get(i)!.masked.length + 1;
				if (cur.length && (size + len > GOOGLE_CHUNK || cur.length >= BATCH_LINES)) {
					groups.push(cur);
					cur = [];
					size = 0;
				}
				cur.push(i);
				size += len;
			}
			if (cur.length) {
				groups.push(cur);
			}
			for (const g of groups) {
				if (!this.googleAvailable() || this.over) {
					break;
				}
				try {
					const raw = await this.gated(() => this.googleOne(g.map((i) => masked.get(i)!.masked).join('\n'), lang));
					this.googleOk();
					const lines = raw.split('\n');
					if (lines.length !== g.length) {
						this.o.log(`[${lang}] Google returned ${lines.length} line(s) for ${g.length}; translating those one by one`);
						continue;
					}
					g.forEach((i, k) => {
						const restored = restore(lines[k], masked.get(i)!.tokens);
						if (restored !== null && restored.trim()) {
							this.cache.set(`${lang}\u0000${texts[i]}`, restored);
							results[i] = { value: restored, fellBack: false };
							this.o.onTranslated?.();
						}
					});
				} catch (e) {
					this.googleFail(e as Error);
					this.o.log(`[${lang}] Google failed (${(e as Error).message}); the rest is translated one by one`);
					break;
				}
			}
		}

		for (let i = 0; i < texts.length; i++) {
			results[i] ??= await this.translate(texts[i], lang);
		}
		return results as MachineResult[];
	}

	private providers(masked: string, lang: string): Prov[] {
		const o = this.o;
		const h = this.h;
		const chunked = async (max: number, one: (c: string) => Promise<string>) => {
			const out: string[] = [];
			for (const c of chunkText(masked, max)) {
				out.push(await one(c));
			}
			return out.join(' ');
		};
		const backend: Prov = {
			name: 'backend',
			available: () => o.provider !== 'google' && h.backendReady && !h.unsupported.has(lang),
			run: () =>
				this.lane(async () => {
					if (!h.backendReady) {
						throw new SkippedError(); // it went down while this request waited its turn
					}
					return chunked(BACKEND_CHUNK, (c) => viaBackend(c, lang, this.sourceLocale, o.backendUrl, o.backendTimeoutMs));
				}),
			ok: () => undefined,
			fail: (e) => {
				if (e instanceof UnsupportedError) {
					h.unsupported.add(lang);
					o.log(`[${lang}] backend does not support this language; using Google for it`);
					return;
				}
				h.backendReady = false; // timeout, HTTP error or a "starting up" page: treat as asleep and wake it again
				this.ensureWake();
			},
		};
		const google: Prov = {
			name: 'google',
			available: () => this.googleAvailable(),
			run: () => chunked(GOOGLE_CHUNK, (c) => this.gated(() => this.googleOne(c, lang))),
			ok: () => this.googleOk(),
			fail: (e) => this.googleFail(e),
		};
		return this.googleFirst() ? [google, backend] : [backend, google];
	}

	private async translateLine(text: string, lang: string): Promise<MachineResult> {
		const key = `${lang}\u0000${text}`;
		const hit = this.cache.get(key);
		if (hit !== undefined) {
			return { value: hit, fellBack: false };
		}
		const done = (value: string) => {
			this.cache.set(key, value);
			this.o.onTranslated?.();
			return { value, fellBack: false };
		};

		const { masked, tokens } = protect(text);
		const order = this.providers(masked, lang);
		let suspect: string | null = null; // backend answer we only use if Google cannot confirm it

		while (!this.over) {
			// the Space is only woken when it is the chosen provider or Google cannot be used right now
			if (this.o.provider === 'backend' || !this.googleAvailable()) {
				this.ensureWake();
			}
			let tried = false;
			for (const p of order) {
				if (!p.available()) {
					continue;
				}
				tried = true;
				try {
					const raw = await p.run();
					p.ok();
					const restored = restore(p.name === 'backend' ? cleanBackend(masked, raw) : raw, tokens);
					if (restored === null) {
						this.o.log(`[${lang}] ${p.name} damaged a placeholder in "${text}", trying next provider`);
						continue;
					}
					if (p.name === 'backend' && looksSuspect(masked, raw)) {
						suspect = restored;
						this.o.log(`[${lang}] backend result for "${text}" looks wrong, cross-checking with Google`);
						continue;
					}
					return done(restored);
				} catch (e) {
					if (e instanceof SkippedError) {
						continue;
					}
					p.fail(e as Error);
					this.o.log(`[${lang}] ${p.name} failed (${(e as Error).message}); retrying`);
				}
			}
			if (suspect !== null) {
				return done(suspect); // Google could not confirm or replace it: a doubtful translation beats a missing one
			}
			if (!tried) {
				if (!this.announcedWake && !this.h.backendReady && this.o.provider === 'auto') {
					this.announcedWake = true;
					this.o.log('all providers busy or cooling down; waiting');
				}
				await sleep(this.t.pollMs);
			}
		}
		// out of time: caller keeps the English text and queues the string for a later retry
		return suspect !== null ? done(suspect) : { value: text, fellBack: true };
	}
}
