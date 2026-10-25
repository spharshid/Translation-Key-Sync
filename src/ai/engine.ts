import { isCancelled, throwIfAborted, waitUnlessAborted } from '../cancel';
import { ContextFile } from '../context';
import { LlmClient, LlmError } from './clients';
import {
	Failure,
	PromptInput,
	PromptItem,
	RefPair,
	buildRetryPrompt,
	buildReviewPrompt,
	buildTranslatePrompt,
	parseJsonReply,
	splitBatches,
	termsForItems,
} from './prompt';
import { CONFIRMABLE, Verdict, validateTranslation } from './validate';

export interface AiTiming {
	/** first wait after a rate-limit answer; doubles each time (a Retry-After header wins) */
	rateBackoffMs: number;
	maxRateRetries: number;
	maxTransientRetries: number;
}

const DEFAULT_TIMING: AiTiming = { rateBackoffMs: 4000, maxRateRetries: 4, maxTransientRetries: 2 };
const MAX_FIX_ROUNDS = 2;
const MAX_SPLIT_DEPTH = 3;

export interface AiEngineOptions {
	/** tried in order; one that cannot be used is skipped for the rest of the run */
	clients: LlmClient[];
	context: ContextFile;
	sourceLocale: string;
	/** a second request that proofreads the drafts (more accurate, one extra request per batch) */
	reviewPass: boolean;
	log: (m: string) => void;
	/** true once the run's time budget is spent */
	stop?: () => boolean;
	/** the user stopped the run: raises Cancelled (unlike `stop`, which only ends the use of AI) so nothing half-done is written */
	signal?: AbortSignal;
	timing?: Partial<AiTiming>;
	maxBatchChars?: number;
	maxBatchItems?: number;
}

export interface AiRequest {
	locale: string;
	file: string;
	items: PromptItem[];
	refs: RefPair[];
}

export interface AiItemResult {
	value: string;
	/** passed every hard check (soft problems may remain and are listed in `problems`) */
	ok: boolean;
	problems: string[];
	model: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const score = (v: Verdict) => v.hard.length * 10 + v.soft.length;

export class AiEngine {
	private readonly dead = new Set<LlmClient>();
	private readonly t: AiTiming;
	/** number of requests sent (for the log / usage awareness) */
	requests = 0;

	constructor(private readonly o: AiEngineOptions) {
		this.t = { ...DEFAULT_TIMING, ...o.timing };
	}

	/** At least one model can still be asked. */
	usable(): boolean {
		return this.o.clients.some((c) => !this.dead.has(c));
	}

	private batchChars(): number {
		const limits = this.o.clients.filter((c) => !this.dead.has(c)).map((c) => c.maxPromptChars ?? Infinity);
		return Math.min(this.o.maxBatchChars ?? 9000, ...limits);
	}

	/** Send one prompt to the first model that works, handling rate limits and temporary failures. */
	private async ask(prompt: string): Promise<{ text: string; model: string } | null> {
		for (const c of this.o.clients) {
			let attempts = 0;
			while (!this.dead.has(c)) {
				throwIfAborted(this.o.signal);
				if (this.o.stop?.()) {
					return null;
				}
				try {
					this.requests++;
					const text = await c.complete(prompt, { signal: this.o.signal });
					return { text, model: c.describe?.() ?? c.label };
				} catch (e) {
					if (isCancelled(e)) {
						throw e;
					}
					const err = e instanceof LlmError ? e : new LlmError((e as Error).message, 'transient');
					if (err.kind === 'unavailable' || err.kind === 'quota') {
						this.dead.add(c);
						this.o.log(`${c.label} cannot be used: ${err.message}`);
						break;
					}
					attempts++;
					const max = err.kind === 'rate' ? this.t.maxRateRetries : this.t.maxTransientRetries;
					if (attempts > max) {
						this.dead.add(c);
						this.o.log(`${c.label} kept failing (${err.message}); not using it for the rest of this run`);
						break;
					}
					const wait = err.retryAfterMs ?? this.t.rateBackoffMs * 2 ** (attempts - 1);
					this.o.log(`${c.label}: ${err.message}; waiting ${Math.round(wait / 1000)}s (retry ${attempts}/${max})`);
					await waitUnlessAborted(sleep, wait, this.o.signal);
				}
			}
		}
		return null;
	}

	/**
	 * Translate a set of strings for one locale. Items that no model could answer are absent from the result
	 * (the caller falls back to another translator); items with a doubtful answer come back with ok=false.
	 */
	async translate(req: AiRequest): Promise<Map<string, AiItemResult>> {
		const results = new Map<string, AiItemResult>();
		for (const batch of splitBatches(req.items, this.batchChars(), this.o.maxBatchItems ?? 40)) {
			if (!this.usable() || this.o.stop?.()) {
				break;
			}
			throwIfAborted(this.o.signal);
			await this.runBatch(req, batch, results, 0);
		}
		return results;
	}

	private input(req: AiRequest, items: PromptItem[]): PromptInput {
		return {
			sourceLocale: this.o.sourceLocale,
			locale: req.locale,
			file: req.file,
			items,
			refs: req.refs,
			context: this.o.context,
		};
	}

	private async runBatch(req: AiRequest, batch: PromptItem[], results: Map<string, AiItemResult>, depth: number): Promise<void> {
		const p = this.input(req, batch);
		const reply = await this.ask(buildTranslatePrompt(p));
		if (!reply) {
			return;
		}
		const parsed = parseJsonReply(reply.text) ?? {};
		const answered = batch.filter((i) => typeof parsed[i.id] === 'string' && parsed[i.id].trim() !== '');
		const missing = batch.filter((i) => !answered.includes(i));

		if (missing.length && depth < MAX_SPLIT_DEPTH) {
			// a truncated or malformed answer: ask again for just the missing ones
			this.o.log(`[${req.locale}] ${missing.length} of ${batch.length} strings missing from the answer; asking again for those`);
			await this.runBatch(req, missing, results, depth + 1);
		}
		if (!answered.length) {
			return;
		}

		const current: Record<string, string> = {};
		for (const i of answered) {
			current[i.id] = parsed[i.id];
		}
		const terms = termsForItems(answered, req.locale, this.o.context);
		const check = (i: PromptItem, v: string) => validateTranslation(i.text, v, req.locale, terms.get(i.id));
		const verdicts = new Map(answered.map((i) => [i.id, check(i, current[i.id])]));

		// rounds of targeted corrections: only the strings that failed a check, with the reasons
		const confirmed = new Set<string>();
		for (let round = 1; round <= MAX_FIX_ROUNDS; round++) {
			const failing = answered.filter((i) => {
				if (confirmed.has(i.id)) {
					return false;
				}
				const v = verdicts.get(i.id)!;
				return v.hard.length || v.soft.length;
			});
			if (!failing.length || !this.usable() || this.o.stop?.()) {
				break;
			}
			const failures: Failure[] = failing.map((i) => {
				const v = verdicts.get(i.id)!;
				return { id: i.id, previous: current[i.id], problems: [...v.hard, ...v.soft] };
			});
			const fix = await this.ask(buildRetryPrompt(p, failures));
			const fixed = fix ? parseJsonReply(fix.text) : null;
			if (!fixed) {
				break;
			}
			for (const i of failing) {
				const cand = fixed[i.id];
				if (typeof cand !== 'string' || !cand.trim()) {
					continue;
				}
				const old = verdicts.get(i.id)!;
				if (cand === current[i.id] && old.hard.length && old.hard.every((h) => CONFIRMABLE.includes(h))) {
					// told it looks untranslated, the model stands by it: jargon or a loanword. Accept it, keep the note.
					verdicts.set(i.id, { hard: [], soft: [...old.soft, ...old.hard.map((h) => `${h} (the model confirmed it is correct)`)] });
					confirmed.add(i.id);
					continue;
				}
				const v = check(i, cand);
				if (score(v) <= score(verdicts.get(i.id)!)) {
					current[i.id] = cand;
					verdicts.set(i.id, v);
				}
			}
		}

		// proofreading pass over everything (kept per string only if it is not worse than the draft)
		if (this.o.reviewPass && this.usable() && !this.o.stop?.()) {
			const rev = await this.ask(buildReviewPrompt({ ...p, items: answered }, current));
			const revised = rev ? parseJsonReply(rev.text) : null;
			if (revised) {
				for (const i of answered) {
					const cand = revised[i.id];
					if (typeof cand !== 'string' || !cand.trim() || cand === current[i.id]) {
						continue;
					}
					const v = check(i, cand);
					const old = verdicts.get(i.id)!;
					if (v.hard.length <= old.hard.length && v.soft.length <= old.soft.length) {
						current[i.id] = cand;
						verdicts.set(i.id, v);
					}
				}
			}
		}

		for (const i of answered) {
			const v = verdicts.get(i.id)!;
			results.set(i.id, { value: current[i.id], ok: v.hard.length === 0, problems: [...v.hard, ...v.soft], model: reply.model });
		}
	}
}
