import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * The optional "context file": product description, tone per language and an approved glossary.
 * It is plain JSON so it can live in the destination repo and be shared by the whole team.
 */
export interface GlossaryEntry {
	/** the source-language word or phrase, e.g. "Board" */
	term: string;
	/** extra source spellings that mean the same, e.g. ["Boards"] */
	aliases?: string[];
	/** what the term means in the product, in plain words: this is what stops a word-for-word translation */
	meaning?: string;
	/** approved translation per locale, in its dictionary (base) form; optional: a language without one still gets the meaning */
	translations: Record<string, string>;
	/** optional, per locale: wrong-sense words that must not be used for this term (typically the literal translation) */
	avoid?: Record<string, string[]>;
}

export interface DoNotTranslateEntry {
	term: string;
	/** optional spelling to use per locale (transliteration); without one the term is kept exactly as written */
	translations?: Record<string, string>;
}

export interface ContextFile {
	/** a shared AI endpoint for everyone using the repo (never the key: each person keeps that in their own secret storage) */
	ai?: { endpoint?: string; model?: string };
	appContext?: string;
	style?: { default?: string; locales?: Record<string, string> };
	glossary: GlossaryEntry[];
	doNotTranslate: DoNotTranslateEntry[];
}

export const EMPTY_CONTEXT: ContextFile = { glossary: [], doNotTranslate: [] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

function strMap(v: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	if (isObj(v)) {
		for (const [k, val] of Object.entries(v)) {
			if (isStr(val)) {
				out[k] = val;
			}
		}
	}
	return out;
}

/** a word, or a list of words, per locale */
function listMap(v: unknown): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	if (isObj(v)) {
		for (const [k, val] of Object.entries(v)) {
			const words = (Array.isArray(val) ? val : [val]).filter(isStr).map((w) => w.trim());
			if (words.length) {
				out[k] = words;
			}
		}
	}
	return out;
}

/** Parse and validate a context file's JSON. Returns the usable content plus human-readable problems. */
export function parseContext(json: unknown): { context: ContextFile; problems: string[] } {
	const problems: string[] = [];
	const ctx: ContextFile = { glossary: [], doNotTranslate: [] };
	if (!isObj(json)) {
		return { context: ctx, problems: ['The context file must be a JSON object.'] };
	}
	if (isStr(json.appContext)) {
		ctx.appContext = json.appContext.trim();
	}
	if (isObj(json.ai)) {
		const endpoint = isStr(json.ai.endpoint) ? json.ai.endpoint.trim() : undefined;
		const model = isStr(json.ai.model) ? json.ai.model.trim() : undefined;
			if (endpoint && !endpoint.toLowerCase().startsWith('http://') && !endpoint.toLowerCase().startsWith('https://')) {
			problems.push('"ai.endpoint" must start with http:// or https://; it is ignored.');
		} else if (endpoint || model) {
			ctx.ai = { endpoint, model };
		}
	}
	if (isObj(json.style)) {
		ctx.style = {
			default: isStr(json.style.default) ? json.style.default.trim() : undefined,
			locales: strMap(json.style.locales),
		};
	}
	if (json.glossary !== undefined && !Array.isArray(json.glossary)) {
		problems.push('"glossary" must be an array.');
	}
	for (const [i, e] of (Array.isArray(json.glossary) ? json.glossary : []).entries()) {
		if (!isObj(e) || !isStr(e.term)) {
			problems.push(`glossary[${i}] needs a "term".`);
			continue;
		}
		const translations = strMap(e.translations);
		const meaning = isStr(e.meaning) ? e.meaning.trim() : isStr(e.note) ? e.note.trim() : undefined; // "note" is the older name
		const avoid = listMap(e.avoid);
		if (!meaning && !Object.keys(translations).length && !Object.keys(avoid).length) {
			problems.push(`glossary[${i}] ("${e.term}") has no "meaning", "translations" or "avoid", so there is nothing to tell the translator; it is ignored.`);
			continue;
		}
		ctx.glossary.push({
			term: e.term.trim(),
			aliases: Array.isArray(e.aliases) ? e.aliases.filter(isStr).map((a) => a.trim()) : undefined,
			meaning,
			translations,
			avoid: Object.keys(avoid).length ? avoid : undefined,
		});
	}
	if (json.doNotTranslate !== undefined && !Array.isArray(json.doNotTranslate)) {
		problems.push('"doNotTranslate" must be an array.');
	}
	for (const [i, e] of (Array.isArray(json.doNotTranslate) ? json.doNotTranslate : []).entries()) {
		if (isStr(e)) {
			ctx.doNotTranslate.push({ term: e.trim() });
		} else if (isObj(e) && isStr(e.term)) {
			const translations = strMap(e.translations);
			ctx.doNotTranslate.push({ term: e.term.trim(), translations: Object.keys(translations).length ? translations : undefined });
		} else {
			problems.push(`doNotTranslate[${i}] must be a string or an object with a "term".`);
		}
	}
	return { context: ctx, problems };
}

export async function loadContext(file: string): Promise<{ context: ContextFile; problems: string[] }> {
	let text: string;
	try {
		text = (await fs.readFile(file, 'utf8')).replace(/^﻿/, '');
	} catch {
		return { context: EMPTY_CONTEXT, problems: [`Context file not found: ${file}`] };
	}
	try {
		return parseContext(JSON.parse(text));
	} catch (e) {
		return { context: EMPTY_CONTEXT, problems: [`Context file is not valid JSON: ${(e as Error).message}`] };
	}
}

/** Where the context file is looked for when the user has not picked one: next to the locale folders. */
export function defaultContextPath(targetDir: string): string {
	return path.join(targetDir, 'i18n-context.json');
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Case-insensitive whole-word matcher for a term (works for phrases; spaces match any whitespace). */
export function termRegex(term: string): RegExp {
	const body = escapeRe(term.trim()).replace(/\s+/g, '\\s+');
	return new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, 'iu');
}

export interface TermHit {
	kind: 'glossary' | 'keep';
	term: string;
	/**
	 * the spelling that must appear in the target language (approved translation, transliteration, or the term itself);
	 * undefined for a glossary term that has a meaning but no approved word in this language
	 */
	target?: string;
	/** what the term means in the product */
	meaning?: string;
	/** words that must not be used for this term in the target language (the wrong sense) */
	avoid?: string[];
}

/** Entries of the context file that occur in this source text, resolved for one target locale. */
export function termsIn(text: string, locale: string, ctx: ContextFile): TermHit[] {
	const hits: TermHit[] = [];
	for (const g of ctx.glossary) {
		const target = g.translations[locale];
		const avoid = g.avoid?.[locale];
		if (!target && !g.meaning && !avoid?.length) {
			continue;
		}
		if ([g.term, ...(g.aliases ?? [])].some((t) => termRegex(t).test(text))) {
			hits.push({ kind: 'glossary', term: g.term, target, meaning: g.meaning, avoid });
		}
	}
	for (const d of ctx.doNotTranslate) {
		if (termRegex(d.term).test(text)) {
			hits.push({ kind: 'keep', term: d.term, target: d.translations?.[locale] ?? d.term });
		}
	}
	return hits;
}

/** Style instruction for a locale (locale-specific text wins over the default). */
export function styleFor(locale: string, ctx: ContextFile): string | undefined {
	return ctx.style?.locales?.[locale] ?? ctx.style?.default;
}

/**
 * Does `output` use the approved target? Exact (case-insensitive) match counts. For languages that inflect
 * (Tamil, Arabic, Slovenian, ...) the approved word may appear with an ending or prefix, so a long shared stem also counts.
 */
export function usesApproved(output: string, target: string): boolean {
	const o = output.toLowerCase();
	const t = target.trim().toLowerCase();
	if (!t) {
		return true;
	}
	if (o.includes(t)) {
		return true;
	}
	// Inflection: every word of the approved term must still be recognisable. Short words (articles, "de") must appear
	// as they are; longer words only need their stem (all but the last two letters, at least four), so "tarjetas de crédito" matches "tarjeta de crédito"
	// and a Tamil/Arabic/Slovenian word with a case ending matches its dictionary form.
	return t.split(/\s+/).every((w) => {
		if (w.length <= 3) {
			return o.includes(w);
		}
		return o.includes(w.slice(0, Math.min(w.length, Math.max(4, w.length - 2))));
	});
}

/** The template written by "Create context file template". Generic on purpose. */
export const CONTEXT_TEMPLATE = {
	$schema: './i18n-context.schema.json',
	_help: [
		'Everything here is optional. Keep what you need, delete the rest (and these examples).',
		'appContext: 1-3 sentences on what the product is and who uses it.',
		'style: the tone, as a default and per language (formal or informal, honorifics...).',
		'glossary: words that mean something specific in YOUR product, where a word-for-word translation would be wrong.',
		'  term, aliases: how the word appears in the English text. List plurals and variants as aliases.',
		'  meaning: what it means in your product, in plain words, and what it is NOT. This is what stops literal translations.',
		'  translations: optional. The approved word for a language, in its dictionary form. Add it only where you know it;',
		'    a language without one still gets the meaning, and the translator picks the right word for that sense.',
		'  avoid: optional. Per language, wrong-sense words the translator must not use for this term (usually the literal translation).',
		'Every field except "term" is optional, and you can fill in just the languages you know.',
		'doNotTranslate: names that must stay as written (company, product). Add "translations" to give a spelling per language.',
	],
	appContext: 'A web application where teams plan and track their work.',
	style: {
		default: 'Clear, polite and concise UI wording. Use the standard form of address for each language.',
		locales: {
			es: 'Use the formal "usted" form.',
		},
	},
	glossary: [
		{
			term: 'Board',
			aliases: ['Boards'],
			meaning: 'A page where cards are arranged in columns to track the progress of work, like a kanban board. It is not a wooden board and not a board of directors.',
			translations: { es: 'tablero' },
			avoid: { es: ['junta'] },
		},
		{
			term: 'Release',
			aliases: ['Releases'],
			meaning: 'A published version of the software, for example version 2.1. It is not the verb "to release" (to let go of something).',
		},
	],
	doNotTranslate: [
		'ProductName',
		{ term: 'CompanyName', translations: { ar: 'اسم الشركة' } },
	],
};

export const CONTEXT_SCHEMA = {
	$schema: 'http://json-schema.org/draft-07/schema#',
	title: 'i18n context file',
	type: 'object',
	properties: {
		$schema: { type: 'string' },
		_help: {},
		ai: {
			type: 'object',
			description: 'Optional AI endpoint and model, shared through this file. Never put the API key here: each developer sets it once in the extension.',
			properties: { endpoint: { type: 'string', description: 'OpenAI-compatible base URL, e.g. https://api.groq.com/openai/v1' }, model: { type: 'string', description: 'One model, or several separated by commas (they share the key but usually have separate allowances).' } },
		},
		appContext: { type: 'string', description: 'What the product is and who uses it.' },
		style: {
			type: 'object',
			properties: {
				default: { type: 'string' },
				locales: { type: 'object', additionalProperties: { type: 'string' }, description: 'Per-language style rules, keyed by locale code.' },
			},
		},
		glossary: {
			type: 'array',
			items: {
				type: 'object',
				required: ['term'],
				properties: {
					term: { type: 'string', description: 'The word or phrase as it appears in the English text.' },
					aliases: { type: 'array', items: { type: 'string' }, description: 'Other spellings that mean the same: plurals, variants.' },
					meaning: { type: 'string', description: 'What the term means in your product, in plain words, and what it is not. Optional, but it is what the translator uses for languages where you gave no approved word.' },
					translations: { type: 'object', additionalProperties: { type: 'string' }, description: 'Optional. Approved translation per locale, in dictionary form. A language without one still gets the meaning.' },
					avoid: {
						type: 'object',
						additionalProperties: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
						description: 'Optional. Per locale, wrong-sense words that must not be used for this term, usually the literal translation.',
					},
				},
			},
		},
		doNotTranslate: {
			type: 'array',
			items: {
				oneOf: [
					{ type: 'string' },
					{
						type: 'object',
						required: ['term'],
						properties: {
							term: { type: 'string' },
							translations: { type: 'object', additionalProperties: { type: 'string' }, description: 'Optional spelling per locale (transliteration).' },
						},
					},
				],
			},
		},
	},
};
