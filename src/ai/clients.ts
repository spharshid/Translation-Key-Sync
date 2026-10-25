import { Cancelled } from '../cancel';

/** A language model we can send a prompt to and get text back from. */
export interface LlmClient {
	/** short name for logs and messages, e.g. "Copilot (gpt-4.1)" */
	readonly label: string;
	/** largest prompt (in characters) worth sending in one request; the engine splits batches to fit */
	readonly maxPromptChars?: number;
	complete(prompt: string, opts?: { signal?: AbortSignal }): Promise<string>;
	/** what answered the last request (a client that rotates models names the one it used), for the log and the summary */
	describe?(): string;
}

export type LlmErrorKind =
	/** slow down and retry the same model */
	| 'rate'
	/** this model cannot be used right now (no consent, no access, not found): try another */
	| 'unavailable'
	/** the daily / monthly allowance is used up: waiting a few minutes will not help */
	| 'quota'
	/** a temporary hiccup: network, 5xx, timeout */
	| 'transient';

export class LlmError extends Error {
	constructor(
		message: string,
		readonly kind: LlmErrorKind,
		readonly retryAfterMs?: number,
	) {
		super(message);
	}
}

export interface OpenAiCompatOptions {
	baseUrl: string;
	model: string;
	apiKey?: string;
	timeoutMs?: number;
	temperature?: number;
	/** how much the model may think before answering ("low" is much faster on models that think by default, e.g. Gemini) */
	reasoningEffort?: string;
	/** largest prompt (characters) worth sending in one request; small local models do better with smaller batches */
	maxPromptChars?: number;
	label?: string;
}

/**
 * Any server that speaks the OpenAI chat-completions protocol: Groq, OpenRouter, Google Gemini (OpenAI-compatible
 * endpoint), Mistral, a local Ollama or LM Studio, ... Only `baseUrl`, `model` and (usually) a key are needed.
 */
export class OpenAiCompatClient implements LlmClient {
	readonly label: string;
	readonly maxPromptChars?: number;

	constructor(private readonly o: OpenAiCompatOptions) {
		this.label = o.label ?? `${o.model} @ ${safeHost(o.baseUrl)}`;
		this.maxPromptChars = o.maxPromptChars;
	}

	async complete(prompt: string, opts: { signal?: AbortSignal } = {}): Promise<string> {
		const url = `${this.o.baseUrl.replace(/\/$/, '')}/chat/completions`;
		let res: Response;
		const timeout = AbortSignal.timeout(this.o.timeoutMs ?? 120_000);
		const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
		try {
			res = await fetch(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...(this.o.apiKey ? { Authorization: `Bearer ${this.o.apiKey}` } : {}),
				},
				body: JSON.stringify({
					model: this.o.model,
					temperature: this.o.temperature ?? 0.2,
					...(this.o.reasoningEffort ? { reasoning_effort: this.o.reasoningEffort } : {}),
					messages: [{ role: 'user', content: prompt }],
				}),
				signal,
			});
		} catch (e) {
			if (opts.signal?.aborted) {
				throw new Cancelled();
			}
			throw new LlmError(`request failed: ${(e as Error).message}`, 'transient');
		}
		if (res.status === 429) {
			const ra = Number(res.headers.get('retry-after'));
			const info = parseRateLimitBody(await res.text().catch(() => ''));
			if (info.daily) {
				throw new LlmError('the daily quota of this model is used up (HTTP 429)', 'quota');
			}
			const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : info.retryMs;
			throw new LlmError('rate limited (HTTP 429)', 'rate', wait);
		}
		if (res.status === 401 || res.status === 403 || res.status === 404) {
			throw new LlmError(`not usable (HTTP ${res.status}); check the key, model name and endpoint`, 'unavailable');
		}
		if (!res.ok) {
			throw new LlmError(`HTTP ${res.status}`, res.status >= 500 ? 'transient' : 'unavailable');
		}
		let data: any;
		try {
			data = await res.json();
		} catch {
			throw new LlmError('the server did not return JSON', 'transient');
		}
		const text = data?.choices?.[0]?.message?.content;
		if (typeof text !== 'string' || !text.trim()) {
			throw new LlmError('empty answer', 'transient');
		}
		return text;
	}
}

function safeHost(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

function findKey(v: unknown, key: string): unknown {
	if (v && typeof v === 'object') {
		for (const [k, x] of Object.entries(v)) {
			if (k === key) {
				return x;
			}
			const r = findKey(x, key);
			if (r !== undefined) {
				return r;
			}
		}
	}
	return undefined;
}

/**
 * What a 429 body says. Google's answers carry a RetryInfo ("retryDelay": "23s") and a QuotaFailure whose quota id names the
 * window ("...PerDay..." means the daily allowance, which a short wait cannot fix); other providers say "per day" in the message.
 */
function parseRateLimitBody(text: string): { daily: boolean; retryMs?: number } {
	const lower = text.toLowerCase();
	const daily = lower.includes('perday') || lower.includes('per day') || lower.includes('daily');
	let retryMs: number | undefined;
	try {
		const delay = findKey(JSON.parse(text), 'retryDelay');
		const secs = typeof delay === 'string' ? Number.parseFloat(delay) : NaN;
		if (Number.isFinite(secs) && secs > 0) {
			retryMs = Math.ceil(secs * 1000);
		}
	} catch {
		// not JSON: no retry hint
	}
	return { daily, retryMs };
}
