import { LlmClient, LlmError, OpenAiCompatClient } from './clients';

/**
 * A free AI service that needs no account and no key: OVHcloud AI Endpoints answers anonymous requests for its hosted
 * open models. The limit is documented: 2 requests per minute, per IP address and per model (HTTP 429 + Retry-After
 * beyond that). This client paces itself to that limit and spreads requests over several models, each of which has its
 * own allowance. It is best effort (the provider can change or withdraw anonymous access), so the engine treats it like
 * any other model that may become unavailable.
 */
export const FREE_ENDPOINT = 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1';
export const FREE_ENDPOINT_NAME = 'OVHcloud AI Endpoints';

/** Best first, matched as case-insensitive fragments of the model ids the service lists. Measured on UI strings in es, sl, ta, ar. */
const PREFER = ['gpt-oss-120b', 'qwen3.5-397b', 'mistral-small', 'qwen3.8', 'llama-3_3-70b', 'qwen3.6', 'gpt-oss-20b'];
const NOT_CHAT = /guard|embed|bge|vl-|-vl|tts|whisper|diffusion|stable|rerank/i;
const PER_MINUTE = 2;
const MAX_WAIT_MS = 3 * 60_000;

export interface FreeClientOptions {
	baseUrl?: string;
	/** injectable for tests */
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	maxWaitMs?: number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class FreeEndpointClient implements LlmClient {
	readonly label = `${FREE_ENDPOINT_NAME} (free, no key)`;
	readonly maxPromptChars = 10_000;

	private readonly base: string;
	private readonly now: () => number;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly maxWait: number;
	private models: string[] | null = null;
	private readonly calls = new Map<string, number[]>();
	private readonly blockedUntil = new Map<string, number>();

	constructor(o: FreeClientOptions = {}) {
		this.base = (o.baseUrl ?? FREE_ENDPOINT).replace(/\/$/, '');
		this.now = o.now ?? Date.now;
		this.sleep = o.sleep ?? realSleep;
		this.maxWait = o.maxWaitMs ?? MAX_WAIT_MS;
	}

	/** The service's chat models, best first (only models we have measured; unknown newcomers are ignored). */
	async discover(): Promise<string[]> {
		if (this.models) {
			return this.models;
		}
		let ids: string[] = [];
		try {
			const res = await fetch(`${this.base}/models`, { signal: AbortSignal.timeout(10_000) });
			if (res.ok) {
				ids = ((await res.json()) as { data?: { id: string }[] }).data?.map((m) => m.id) ?? [];
			}
		} catch {
			// fall through to the static list below
		}
		const chat = ids.filter((id) => !NOT_CHAT.test(id));
		const ranked = PREFER.flatMap((p) => chat.filter((id) => id.toLowerCase().includes(p)));
		this.models = [...new Set(ranked)];
		if (!this.models.length) {
			// listing failed or none of the known models is offered right now: try the best-known names anyway
			this.models = ['gpt-oss-120b', 'Mistral-Small-3.2-24B-Instruct-2506', 'Meta-Llama-3_3-70B-Instruct'];
		}
		return this.models;
	}

	private recent(model: string): number[] {
		const cutoff = this.now() - 60_000;
		const list = (this.calls.get(model) ?? []).filter((t) => t > cutoff);
		this.calls.set(model, list);
		return list;
	}

	/** When this model may be used again (0 = now). */
	private freeAt(model: string): number {
		const recent = this.recent(model);
		const slotFree = recent.length >= PER_MINUTE ? recent[recent.length - PER_MINUTE] + 60_000 : 0;
		return Math.max(slotFree, this.blockedUntil.get(model) ?? 0);
	}

	async complete(prompt: string, opts: { signal?: AbortSignal } = {}): Promise<string> {
		const waitedFrom = this.now();
		for (;;) {
			const models = await this.discover();
			if (!models.length) {
				throw new LlmError('no model is offered by the free service right now', 'unavailable');
			}
			const ready = models.find((m) => this.freeAt(m) <= this.now());
			if (!ready) {
				const next = Math.min(...models.map((m) => this.freeAt(m)));
				const wait = Math.max(250, next - this.now() + 250);
				if (this.now() - waitedFrom + wait > this.maxWait) {
					throw new LlmError('the free service is rate limiting this connection (2 requests per minute per model)', 'rate', wait);
				}
				await this.sleep(wait);
				continue;
			}
			this.calls.set(ready, [...this.recent(ready), this.now()]);
			try {
				return await new OpenAiCompatClient({ baseUrl: this.base, model: ready, timeoutMs: 180_000, temperature: 0.2 }).complete(prompt, opts);
			} catch (e) {
				if (e instanceof LlmError && e.kind === 'rate') {
					// someone else behind the same IP used the allowance: honour Retry-After and try another model
					this.blockedUntil.set(ready, this.now() + (e.retryAfterMs ?? 30_000));
					continue;
				}
				if (e instanceof LlmError && e.kind === 'unavailable') {
					this.models = models.filter((m) => m !== ready); // the model was withdrawn
					if (!this.models.length) {
						throw e;
					}
					continue;
				}
				throw e;
			}
		}
	}
}
