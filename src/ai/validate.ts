import { TermHit, usesApproved } from '../context';
import { PLACEHOLDER_RE, samePlaceholders } from '../placeholders';

/**
 * Hard problems a model may legitimately overrule: jargon, product terms or loanwords can stay unchanged in a Latin-script
 * language. If the model is told the text looks untranslated and still returns the same text, it is accepted with a warning.
 * (Wrong script, empty output and damaged placeholders can never be overruled.)
 */
export const CONFIRMABLE = ['identical to the English source', 'most words are still the English source words'];

export interface Verdict {
	/** the translation is unusable as it is (lost placeholder, empty, still English, wrong script...) */
	hard: string[];
	/** probably fine but worth one more attempt (missing approved term, punctuation, whitespace...) */
	soft: string[];
}

/** Unicode scripts the output should be written in; Latin-script targets are not listed. */
const SCRIPT: Record<string, RegExp> = {
	ar: /\p{Script=Arabic}/u,
	fa: /\p{Script=Arabic}/u,
	ur: /\p{Script=Arabic}/u,
	he: /\p{Script=Hebrew}/u,
	ta: /\p{Script=Tamil}/u,
	te: /\p{Script=Telugu}/u,
	kn: /\p{Script=Kannada}/u,
	ml: /\p{Script=Malayalam}/u,
	bn: /\p{Script=Bengali}/u,
	gu: /\p{Script=Gujarati}/u,
	pa: /\p{Script=Gurmukhi}/u,
	hi: /\p{Script=Devanagari}/u,
	mr: /\p{Script=Devanagari}/u,
	ne: /\p{Script=Devanagari}/u,
	ru: /\p{Script=Cyrillic}/u,
	uk: /\p{Script=Cyrillic}/u,
	bg: /\p{Script=Cyrillic}/u,
	sr: /\p{Script=Cyrillic}/u,
	el: /\p{Script=Greek}/u,
	th: /\p{Script=Thai}/u,
	zh: /\p{Script=Han}/u,
	ja: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u,
	ko: /\p{Script=Hangul}/u,
};

const baseLang = (locale: string) => locale.toLowerCase().split(/[-_]/)[0];
const END_PUNCT = /[.!?:;…。！？：؟]$/;

/** Letters of a string once placeholders and kept terms are removed (what actually needs translating). */
function translatable(text: string, keep: string[]): string {
	let t = text.replace(PLACEHOLDER_RE, ' ');
	for (const k of keep) {
		t = t.split(k).join(' ');
	}
	return t;
}

const wordsOf = (s: string) => s.toLowerCase().match(/\p{L}{4,}/gu) ?? [];

export function validateTranslation(source: string, output: string, locale: string, terms: TermHit[] = []): Verdict {
	const hard: string[] = [];
	const soft: string[] = [];
	if (!source.trim()) {
		return { hard, soft };
	}
	if (!output.trim()) {
		return { hard: ['empty translation'], soft };
	}
	if (!samePlaceholders(source, output)) {
		hard.push('placeholders were changed, lost or added (they must be copied exactly)');
	}

	const keep = terms.filter((t) => t.kind === 'keep').map((t) => t.term);
	const srcText = translatable(source, keep);
	const outText = translatable(output, terms.flatMap((t) => (t.target ? [t.target] : [])));
	const srcLetters = (srcText.match(/\p{L}/gu) ?? []).length;

	if (srcLetters >= 3) {
		const script = SCRIPT[baseLang(locale)];
		if (script) {
			const letters = outText.match(/\p{L}/gu) ?? [];
			const inScript = letters.filter((c) => script.test(c)).length;
			if (letters.length >= 3 && inScript / letters.length < 0.5) {
				hard.push(`most of the text is not written in the ${locale} script (looks untranslated)`);
			}
		} else {
			const src = wordsOf(srcText);
			if (output.trim().toLowerCase() === source.trim().toLowerCase() && src.length >= 2) {
				hard.push('identical to the English source');
			} else if (src.length >= 3) {
				const out = new Set(wordsOf(outText));
				if (src.filter((w) => out.has(w)).length / src.length >= 0.8) {
					hard.push('most words are still the English source words');
				}
			}
		}
	}

	if (source.trim().length >= 12) {
		const ratio = output.length / source.length;
		if (ratio > 4 || ratio < 0.2) {
			soft.push(`length looks wrong (${Math.round(ratio * 100)}% of the source)`);
		}
	}
	if (END_PUNCT.test(source.trim()) && !END_PUNCT.test(output.trim())) {
		soft.push('the source ends with punctuation but the translation does not');
	}
	if (/^\s/.test(source) !== /^\s/.test(output) || /\s$/.test(source) !== /\s$/.test(output)) {
		soft.push('leading/trailing whitespace differs from the source');
	}
	if ((source.match(/\n/g) ?? []).length !== (output.match(/\n/g) ?? []).length) {
		soft.push('the number of line breaks differs from the source');
	}
	for (const t of terms) {
		// words the file says are the wrong sense; one that is part of the approved word is not held against the output
		const wrong = (t.avoid ?? []).find((w) => !t.target?.toLowerCase().includes(w.toLowerCase()) && usesApproved(output, w));
		if (wrong) {
			soft.push(`must not use "${wrong}" for "${t.term}" (the wrong sense in this product)`);
		}
		if (!t.target) {
			continue; // a term with only a meaning has no approved word to check for
		}
		// a kept name must appear exactly as given (no inflection); glossary words may take endings, so a shared stem is enough
		const ok = t.kind === 'keep' ? output.toLowerCase().includes(t.target.toLowerCase()) : usesApproved(output, t.target);
		if (!ok) {
			soft.push(
				t.kind === 'keep'
					? `"${t.term}" must stay as "${t.target}"`
					: `must use the approved translation "${t.target}" for "${t.term}" (inflected to fit the sentence)`,
			);
		}
	}
	return { hard, soft };
}
