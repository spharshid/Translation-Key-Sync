import { LlmClient, LlmError, OpenAiCompatClient } from './clients';

export interface PoolOptions {
	baseUrl: string;
	models: string[];
	apiKey?: string;
	timeoutMs?: number;
	reasoningEffort?: string;
	/** told when a model is skipped or an answer is slow */
	log?: (message: string) => void;
	/** injectable for tests */
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	maxWaitMs?: number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const QUOTA_RECHECK_MS = 60 * 60_000;
const DEFAULT_RATE_PAUSE_MS = 20_000;
/** a model that is overloaded or timing out is left alone for a moment while the next one is tried */
const TRANSIENT_PAUSE_MS = 30_000;
const SLOW_MS = 20_000;

/**
 * Several models of one provider behind a single key. Free tiers (Gemini, Groq, OVH, ...) count the allowance per model, so
 * rotating to the next model when one is rate limited or out of its daily quota multiplies what a key can do. Models are tried
 * in the order given; a model that is limited is skipped until its allowance returns.
 */
export class PooledClient implements LlmClient {
	readonly label: string;
	private models: string[];
	private readonly blocked = new Map<string, { until: number; quota: boolean }>();
	private readonly now: () => number;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly maxWait: number;

	constructor(private readonly o: PoolOptions) {
		this.models = [...o.models];
		this.label = `${o.models[0]} +${o.models.length - 1} more`;
		this.now = o.now ?? Date.now;
		this.sleep = o.sleep ?? realSleep;
		this.maxWait = o.maxWaitMs ?? 2 * 60_000;
	}

	async complete(prompt: string, opts: { signal?: AbortSignal } = {}): Promise<string> {
		const waitedFrom = this.now();
		for (;;) {
			if (!this.models.length) {
				throw new LlmError('none of the configured models can be used (check the key and the model names)', 'unavailable');
			}
			const ready = this.models.find((m) => (this.blocked.get(m)?.until ?? 0) <= this.now());
			if (!ready) {
				if (this.models.every((m) => this.blocked.get(m)?.quota)) {
					throw new LlmError('the daily quota of every configured model is used up', 'quota');
				}
				const next = Math.min(...this.models.map((m) => this.blocked.get(m)?.until ?? 0));
				const wait = Math.max(250, next - this.now() + 250);
				if (this.now() - waitedFrom + wait > this.maxWait) {
					throw new LlmError('every configured model is rate limited right now', 'rate', wait);
				}
				await this.sleep(wait);
				continue;
			}
			const began = this.now();
			try {
				const answer = await new OpenAiCompatClient({ baseUrl: this.o.baseUrl, model: ready, apiKey: this.o.apiKey, timeoutMs: this.o.timeoutMs, reasoningEffort: this.o.reasoningEffort }).complete(prompt, opts);
				if (this.now() - began > SLOW_MS) {
					this.o.log?.(`${ready} answered slowly (${Math.round((this.now() - began) / 1000)} s)`);
				}
				return answer;
			} catch (e) {
				if (!(e instanceof LlmError)) {
					throw e;
				}
				this.o.log?.(`${ready}: ${e.message}${e.kind === 'unavailable' ? ', not used any more' : ''} (${Math.round((this.now() - began) / 1000)} s)`);
				if (e.kind === 'rate') {
					this.blocked.set(ready, { until: this.now() + (e.retryAfterMs ?? DEFAULT_RATE_PAUSE_MS), quota: false });
					continue;
				}
				if (e.kind === 'quota') {
					this.blocked.set(ready, { until: this.now() + QUOTA_RECHECK_MS, quota: true });
					continue;
				}
				if (e.kind === 'unavailable') {
					this.models = this.models.filter((m) => m !== ready); // unknown model or no access to it
					if (!this.models.length) {
						throw e;
					}
					continue;
				}
				if (e.kind === 'transient') {
					// overloaded (HTTP 503), timed out, empty answer: try the next model right away instead of hammering this one
					this.blocked.set(ready, { until: this.now() + TRANSIENT_PAUSE_MS, quota: false });
					if (this.models.some((m) => (this.blocked.get(m)?.until ?? 0) <= this.now())) {
						continue;
					}
				}
				throw e;
			}
		}
	}
}
