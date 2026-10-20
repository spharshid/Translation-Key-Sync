export type Provider = 'auto' | 'backend' | 'google';

export interface Timing {
	googleBackoffBaseMs: number;
	googleBackoffMaxMs: number;
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
	wakeProbeMs: 8000,
	wakeRequestTimeoutMs: 5 * 60_000,
	wakeRetryMs: 15_000,
	wakeGiveUpMs: 15 * 60_000,
	pollMs: 500,
};

export interface TranslatorOptions {
	backendUrl: string;
	googleUrl?: string;
	backendTimeoutMs: number;
	provider: Provider;
	/** how many strings this run will translate; big runs go Google-first because the Space is slow */
	expectedStrings: number;
	/** after this long the run stops waiting and leaves the remaining strings to the pending queue */
	budgetMs?: number;
	timing?: Partial<Timing>;
	log: (msg: string) => void;
	onTranslated?: () => void;
}

const BIG_RUN = 30;
const DEFAULT_BUDGET_MS = 5 * 60_000;
const GOOGLE_URL = 'https://translate.googleapis.com/translate_a/single';
// the Space truncates at 128 tokens, so send it short chunks; Google takes a URL, so keep that short too
const BACKEND_CHUNK = 220;
const GOOGLE_CHUNK = 1200;

class SkippedError extends Error {}
class UnsupportedError extends Error {}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// {{name}}, {name}, {"json": 1}, %s / %d, $t(key), <b>, </b>, <Name>, &nbsp;
const PLACEHOLDER_RE = /\{\{[^}]*\}\}|\{[^{}]*\}|%[sdif]|\$t\([^)]*\)|<\/?[a-zA-Z0-9]+[^>]*>|&[a-z]+;/g;

function protect(text: string): { masked: string; tokens: string[] } {
	const tokens: string[] = [];
	const masked = text.replace(PLACEHOLDER_RE, (m) => {
		tokens.push(m);
		return `__PH${tokens.length - 1}__`;
	});
	return { masked, tokens };
}

function restore(text: string, tokens: string[]): string | null {
	let ok = true;
	const out = text.replace(/__\s?PH\s?(\d+)\s?__/gi, (_m, i) => {
		const t = tokens[Number(i)];
		if (t === undefined) {
			ok = false;
			return _m;
		}
		return t;
	});
	if (!ok) {
		return null;
	}
	// every protected token must have survived
	for (const t of tokens) {
		if (!out.includes(t)) {
			return null;
		}
	}
	return out;
}

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
	// a sleeping Space or a blocked Google answers with an HTML page: that throws here and counts as a failure
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

async function viaGoogle(text: string, lang: string, sl: string, base: string): Promise<string> {
	const url = `${base}?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(lang)}&dt=t&q=${encodeURIComponent(text)}`;
	const data = await fetchJson(url, {}, 20_000);
	if (!Array.isArray(data?.[0])) {
		throw new Error('bad response');
	}
	return (data[0] as unknown[][]).map((i) => i[0]).join('');
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
	googleCooldownUntil = 0;
	readonly unsupported = new Set<string>(); // target languages the backend does not offer
}

interface Prov {
	name: 'backend' | 'google';
	available: () => boolean;
	run: () => Promise<string>;
	ok: () => void;
	fail: (e: Error) => void;
}

export class Translator {
	private readonly cache = new Map<string, string>();
	private backendLane: Promise<unknown> = Promise.resolve(); // the Space handles one request at a time
	private readonly t: Timing;
	private readonly deadline: number;
	private readonly googleBase: string;
	private announcedWake = false;

	constructor(
		private readonly o: TranslatorOptions,
		private readonly sourceLocale: string,
		private readonly h: ProviderHealth = new ProviderHealth(),
	) {
		this.t = { ...DEFAULT_TIMING, ...o.timing };
		this.deadline = Date.now() + (o.budgetMs ?? DEFAULT_BUDGET_MS);
		this.googleBase = o.googleUrl || GOOGLE_URL;
	}

	/** Call once before translating: starts waking the backend and gives it a short head start. */
	async prepare(): Promise<void> {
		if (this.o.provider === 'google') {
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

	private googleFirst() {
		return this.o.provider === 'google' || (this.o.provider === 'auto' && this.o.expectedStrings > BIG_RUN);
	}

	/** Translate one string; multi-line strings are translated line by line so the line breaks survive. */
	async translate(text: string, lang: string): Promise<{ value: string; fellBack: boolean }> {
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
			available: () => o.provider !== 'backend' && Date.now() >= h.googleCooldownUntil,
			run: () => chunked(GOOGLE_CHUNK, (c) => viaGoogle(c, lang, this.sourceLocale, this.googleBase)),
			ok: () => {
				h.googleFails = 0;
				h.googleCooldownUntil = 0;
			},
			fail: () => {
				h.googleFails++;
				const wait = Math.min(this.t.googleBackoffBaseMs * 2 ** (h.googleFails - 1), this.t.googleBackoffMaxMs);
				h.googleCooldownUntil = Date.now() + wait;
			},
		};
		return this.googleFirst() ? [google, backend] : [backend, google];
	}

	private async translateLine(text: string, lang: string): Promise<{ value: string; fellBack: boolean }> {
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

		while (Date.now() < this.deadline) {
			this.ensureWake();
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
