import { throwIfAborted } from './cancel';
import { AiEngine } from './ai/engine';
import type { PromptItem, RefPair } from './ai/prompt';
import { validateTranslation } from './ai/validate';
import { ContextFile, termRegex, termsIn } from './context';
import type { Memory } from './memory';
import { PLACEHOLDER_RE } from './placeholders';
import { Translator } from './translator';

/**
 * memory   reused from an existing approved translation of exactly the same text
 * ai       a language model translated it with the product context (the quality we want)
 * classic  machine translation (Hugging Face Space / Google): usable but lower quality, queued for an AI redo
 * english  nothing worked in time: the English text is written and queued
 */
export type Origin = 'memory' | 'ai' | 'classic' | 'english';

export interface Translated {
	value: string;
	origin: Origin;
	warnings: string[];
	/** which model or service made it (counted in the summary after a sync) */
	via?: string;
}

export interface BatchRequest {
	locale: string;
	file: string;
	items: PromptItem[];
	refs: RefPair[];
	/** use only the AI: unresolved strings come back as 'english' instead of falling back to machine translation */
	aiOnly?: boolean;
}

export interface ServiceOptions {
	ai?: AiEngine;
	/** approved translations that already exist; exact matches are reused instead of translating again */
	memory?: Memory;
	/** the user wants AI translation (even if no model is reachable right now), so machine results get queued for a redo */
	aiWanted?: boolean;
	/** the user stopped the run: raises Cancelled instead of returning half-done results */
	signal?: AbortSignal;
	/** created on first use so its time budget starts when the fallback is actually needed */
	classic: () => Translator;
	context: ContextFile;
	sourceLocale: string;
	log: (m: string) => void;
	onTranslated?: () => void;
}

/** Nothing to translate: no letters once placeholders are removed (numbers, symbols, bare tags). */
export function isTrivial(text: string): boolean {
	return !/\p{L}/u.test(text.replace(PLACEHOLDER_RE, ''));
}

/** Swap glossary / do-not-translate terms for tokens so a machine translator cannot mangle them. */
function maskTerms(text: string, locale: string, ctx: ContextFile): { masked: string; targets: string[] } {
	const targets: string[] = [];
	let masked = text;
	const apply = (spellings: string[], target: string) => {
		for (const s of spellings) {
			const re = new RegExp(termRegex(s).source, 'giu');
			masked = masked.replace(re, () => {
				targets.push(target);
				return `__GT${targets.length - 1}__`;
			});
		}
	};
	for (const g of ctx.glossary) {
		const t = g.translations[locale];
		if (t) {
			apply([g.term, ...(g.aliases ?? [])], t);
		}
	}
	for (const d of ctx.doNotTranslate) {
		apply([d.term], d.translations?.[locale] ?? d.term);
	}
	return { masked, targets };
}

function unmask(text: string, targets: string[]): string | null {
	let ok = true;
	const out = text.replace(/__\s?GT\s?(\d+)\s?__/gi, (_m, i) => {
		const t = targets[Number(i)];
		if (t === undefined) {
			ok = false;
			return _m;
		}
		return t;
	});
	return ok && !/__\s?GT/i.test(out) && targets.every((t) => out.includes(t)) ? out : null;
}

export class TranslationService {
	private classicInstance: Translator | null = null;

	constructor(private readonly o: ServiceOptions) {}

	/** An AI model can still be asked right now. */
	get aiAvailable(): boolean {
		return !!this.o.ai?.usable();
	}

	/** An AI model was requested for this run (so machine-translated strings should be redone by it later). */
	get aiIntended(): boolean {
		return this.o.aiWanted ?? this.o.ai !== undefined;
	}

	private async classic(): Promise<Translator> {
		if (!this.classicInstance) {
			this.classicInstance = this.o.classic();
			await this.classicInstance.prepare(); // only wakes the Hugging Face Space when we actually need a fallback
		}
		return this.classicInstance;
	}

	/** Translate many strings of one file into one locale. Every requested id is present in the result. */
	async translateBatch(req: BatchRequest): Promise<Map<string, Translated>> {
		throwIfAborted(this.o.signal);
		const out = new Map<string, Translated>();
		const done = (id: string, r: Translated) => {
			out.set(id, r);
			this.o.onTranslated?.();
		};

		const todo: PromptItem[] = [];
		for (const it of req.items) {
			const known = this.o.memory?.(req.locale, it.text);
			if (isTrivial(it.text)) {
				done(it.id, { value: it.text, origin: 'ai', warnings: [] });
			} else if (known !== undefined) {
				done(it.id, { value: known, origin: 'memory', warnings: [], via: 'translation memory' });
			} else {
				todo.push(it);
			}
		}

		const candidates = new Map<string, { value: string; problems: string[] }>();
		if (this.o.ai?.usable() && todo.length) {
			const ai = await this.o.ai.translate({ ...req, items: todo });
			for (const [id, r] of ai) {
				if (r.ok) {
					done(id, { value: r.value, origin: 'ai', warnings: r.problems, via: r.model });
				} else {
					candidates.set(id, { value: r.value, problems: r.problems });
				}
			}
		}

		throwIfAborted(this.o.signal); // stopped while the AI was working: do not turn the rest into English or machine translation
		const rest = todo.filter((i) => !out.has(i.id));
		if (rest.length && req.aiOnly) {
			for (const it of rest) {
				done(it.id, { value: it.text, origin: 'english', warnings: candidates.get(it.id)?.problems ?? [] });
			}
		} else if (rest.length) {
			if (this.o.ai) {
				this.o.log(`[${req.locale}] ${rest.length} string(s) fall back to machine translation (queued for an AI redo later)`);
			}
			const results = await this.viaClassicBatch(rest, req.locale, candidates);
			throwIfAborted(this.o.signal);
			rest.forEach((it, i) => done(it.id, results[i].origin === 'classic' ? { ...results[i], via: 'machine translation' } : results[i]));
		}
		return out;
	}

	/**
	 * Machine translation for the strings the AI could not do. The glossary and the names to keep are swapped for tokens first
	 * (so the context file protects the machine translator too), the strings go out in a few packed requests, and each result
	 * is checked with the same validator as the AI's answers.
	 */
	private async viaClassicBatch(
		items: PromptItem[],
		locale: string,
		candidates: Map<string, { value: string; problems: string[] }>,
	): Promise<Translated[]> {
		const classic = await this.classic();
		const ctx = this.o.context;
		const prepared = items.map((it) => ({ it, ...maskTerms(it.text, locale, ctx) }));
		const raw = await classic.translateMany(
			prepared.map((p) => (p.targets.length ? p.masked : p.it.text)),
			locale,
		);
		const out: Translated[] = [];
		for (const [i, p] of prepared.entries()) {
			let r = raw[i];
			let value = r.value;
			if (p.targets.length && !r.fellBack) {
				const un = unmask(r.value, p.targets);
				if (un === null) {
					// the tokens did not survive: translate without masking rather than lose the string
					r = await classic.translate(p.it.text, locale);
					value = r.value;
				} else {
					value = un;
				}
			}
			out.push(this.judge(p.it, locale, r.fellBack, value, candidates.get(p.it.id)));
		}
		return out;
	}

	private judge(it: PromptItem, locale: string, fellBack: boolean, value: string, aiCandidate?: { value: string; problems: string[] }): Translated {
		if (fellBack) {
			return aiCandidate
				? { value: aiCandidate.value, origin: 'ai', warnings: aiCandidate.problems }
				: { value: it.text, origin: 'english', warnings: [] };
		}
		const terms = termsIn(it.text, locale, this.o.context);
		const v = validateTranslation(it.text, value, locale, terms);
		if (aiCandidate) {
			const vc = validateTranslation(it.text, aiCandidate.value, locale, terms);
			if (vc.hard.length < v.hard.length || (vc.hard.length === v.hard.length && vc.soft.length < v.soft.length)) {
				return { value: aiCandidate.value, origin: 'ai', warnings: aiCandidate.problems };
			}
		}
		return { value, origin: 'classic', warnings: [...v.hard, ...v.soft] };
	}
}
