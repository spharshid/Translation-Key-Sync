import { ContextFile, TermHit, styleFor, termsIn } from '../context';

export interface PromptItem {
	id: string;
	text: string;
	/** dotted key path, e.g. "buttons.save": tells the model where the string appears */
	keyPath: string;
}

/** An already-approved translation from the same product, used to keep terminology and tone consistent. */
export interface RefPair {
	key: string;
	source: string;
	target: string;
}

export interface PromptInput {
	sourceLocale: string;
	locale: string;
	file: string;
	items: PromptItem[];
	refs: RefPair[];
	context: ContextFile;
}

function languageName(code: string): string {
	try {
		return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
	} catch {
		return code;
	}
}

/** Glossary terms found in the batch, per item. */
export function termsForItems(items: PromptItem[], locale: string, ctx: ContextFile): Map<string, TermHit[]> {
	const m = new Map<string, TermHit[]>();
	for (const it of items) {
		m.set(it.id, termsIn(it.text, locale, ctx));
	}
	return m;
}

function glossaryBlock(items: PromptItem[], locale: string, ctx: ContextFile): string {
	const seen = new Map<string, TermHit>();
	for (const hits of termsForItems(items, locale, ctx).values()) {
		for (const h of hits) {
			seen.set(`${h.kind}:${h.term}`, h);
		}
	}
	if (!seen.size) {
		return '';
	}
	const all = [...seen.values()];
	const approved = all.filter((h) => h.kind === 'keep' || h.target);
	const byMeaning = all.filter((h) => h.kind === 'glossary' && !h.target);
	const never = (h: TermHit) => (h.avoid?.length ? `  NEVER use ${h.avoid.map((w) => `"${w}"`).join(', ')} for it (the wrong sense in this product)` : '');
	const lines = approved.map((h) =>
		h.kind === 'keep'
			? `- KEEP "${h.term}" as "${h.target}" (a name: never translate it${h.target !== h.term ? ', use this spelling' : ''})`
			: `- "${h.term}" => "${h.target}"${h.meaning ? `  (meaning in this product: ${h.meaning})` : ''}${never(h)}`,
	);
	let out = '';
	if (lines.length) {
		out += `\nApproved glossary (mandatory). Use the approved word as the core of the phrase, but inflect, conjugate and position it so the sentence is grammatical (case, number, gender, tense, agreement). Do not paste it in a wrong form, and do not use a different word for the same concept:\n${lines.join('\n')}\n`;
	}
	if (byMeaning.length) {
		const lang = languageName(locale);
		out += `\nProduct terms with no approved ${lang} word. In this product they have a specific meaning that a word-for-word translation would get wrong. Translate by the meaning given, never literally: choose the word a ${lang} speaker working in this field would use for that concept, use it consistently, and inflect it so the sentence is grammatical:\n${byMeaning.map((h) => `- "${h.term}": ${h.meaning ?? 'a product-specific term'}${never(h)}`).join('\n')}\n`;
	}
	return out;
}

function header(p: PromptInput): string {
	const src = languageName(p.sourceLocale);
	const tgt = languageName(p.locale);
	const style = styleFor(p.locale, p.context);
	return [
		`You are a senior software localization specialist translating the user interface of a web application from ${src} into ${tgt} (locale code "${p.locale}").`,
		'',
		`Quality bar: your output will be checked by native ${tgt} reviewers and by automated code-review tools. It must read as if it had been written by a native speaker: natural and idiomatic, grammatically correct (case, gender, number, tense, agreement, word order), consistent in terminology, and as concise as a UI label should be. Never translate word for word when that sounds unnatural.`,
		p.context.appContext ? `\nProduct context: ${p.context.appContext}` : '',
		style ? `\nStyle for ${tgt}: ${style}` : '',
		glossaryBlock(p.items, p.locale, p.context),
	]
		.filter((x) => x !== '')
		.join('\n');
}

const RULES = (tgt: string) => `
Rules
1. Translate the meaning, choosing the sense that fits a software UI. The key path shows where each string appears ("buttons.*" is a button label, "errors.*" or "validation.*" an error message, "tooltip.*" a hint, and so on); use the matching register and grammatical form (imperative for buttons, full sentences for messages).
2. Copy placeholders EXACTLY as written, the same number of each, placed wherever ${tgt} grammar needs them: {{name}}, {count}, %s, %d, <b>...</b>, <Name>, $t(key), &nbsp;. Never translate text inside a placeholder or tag.
3. Keep the same punctuation style, capitalization style, leading/trailing spaces and line breaks as the source.
4. Do not leave English words in the translation, except product or brand names, code, and terms marked KEEP.
5. Follow the terminology and tone of the reference translations (if any) for the same concepts.
6. Output ONLY one JSON object mapping each id to its translation, using exactly the ids given. No explanations, no markdown.`;

function refsBlock(refs: RefPair[], p: PromptInput): string {
	if (!refs.length) {
		return '';
	}
	const lines = refs.map((r) => JSON.stringify({ key: r.key, [p.sourceLocale]: r.source, [p.locale]: r.target }));
	return `\nReference translations already approved in this product (match their terminology and tone):\n${lines.join('\n')}\n`;
}

function itemsBlock(items: PromptItem[]): string {
	return items.map((i) => JSON.stringify({ id: i.id, key: i.keyPath, text: i.text })).join('\n');
}

export function buildTranslatePrompt(p: PromptInput): string {
	return [
		header(p),
		RULES(languageName(p.locale)),
		refsBlock(p.refs, p),
		`File: ${p.file}`,
		`\nTranslate these strings (one JSON object per line):\n${itemsBlock(p.items)}`,
		`\nReturn: {"<id>": "<translation>", ...} for all ${p.items.length} ids.`,
	].join('\n');
}

export interface Failure {
	id: string;
	previous: string;
	problems: string[];
}

export function buildRetryPrompt(p: PromptInput, failures: Failure[]): string {
	const byId = new Map(p.items.map((i) => [i.id, i]));
	const bad = failures
		.map((f) => JSON.stringify({ id: f.id, key: byId.get(f.id)?.keyPath, text: byId.get(f.id)?.text, previous: f.previous, problems: f.problems }))
		.join('\n');
	return [
		header({ ...p, items: failures.map((f) => byId.get(f.id)!).filter(Boolean) }),
		RULES(languageName(p.locale)),
		refsBlock(p.refs, p),
		`\nYour previous translations of these strings had problems. Fix every listed problem and return corrected translations (one JSON object per line shows the source, your previous attempt and the problems):\n${bad}`,
		`\nReturn: {"<id>": "<corrected translation>", ...} for exactly these ${failures.length} ids.`,
	].join('\n');
}

export function buildReviewPrompt(p: PromptInput, drafts: Record<string, string>): string {
	const rows = p.items.map((i) => JSON.stringify({ id: i.id, key: i.keyPath, text: i.text, draft: drafts[i.id] }));
	return [
		header(p),
		RULES(languageName(p.locale)),
		refsBlock(p.refs, p),
		`\nYou are now the reviewer. For each item below check the draft translation for: accuracy of meaning in a UI context, grammar and agreement, naturalness for a native speaker, terminology against the glossary and references, placeholders copied exactly, punctuation, and leftover English. Correct anything that is wrong or unnatural; leave correct drafts exactly as they are.\n${rows.join('\n')}`,
		`\nReturn: {"<id>": "<final translation>", ...} for all ${p.items.length} ids.`,
	].join('\n');
}

/** Pull the JSON object out of a model reply (tolerates code fences and surrounding prose). */
export function parseJsonReply(reply: string): Record<string, string> | null {
	const start = reply.indexOf('{');
	const end = reply.lastIndexOf('}');
	if (start < 0 || end <= start) {
		return null;
	}
	try {
		const obj = JSON.parse(reply.slice(start, end + 1));
		if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
			return null;
		}
		const out: Record<string, string> = {};
		for (const [k, v] of Object.entries(obj)) {
			if (typeof v === 'string') {
				out[k] = v;
			}
		}
		return out;
	} catch {
		return null;
	}
}

/** Group items into requests that stay under a character budget (a rough proxy for tokens). */
export function splitBatches<T extends { text: string }>(items: T[], maxChars: number, maxItems: number): T[][] {
	const batches: T[][] = [];
	let cur: T[] = [];
	let size = 0;
	for (const it of items) {
		const cost = it.text.length + 80; // key path + JSON overhead
		if (cur.length && (size + cost > maxChars || cur.length >= maxItems)) {
			batches.push(cur);
			cur = [];
			size = 0;
		}
		cur.push(it);
		size += cost;
	}
	if (cur.length) {
		batches.push(cur);
	}
	return batches;
}
