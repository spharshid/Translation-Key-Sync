import type { RefPair } from './prompt';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Every string leaf of a JSON document, keyed by dotted path ("a.b[0].c"). */
export function flattenStrings(doc: unknown): Map<string, string> {
	const out = new Map<string, string>();
	const walk = (v: unknown, p: string) => {
		if (typeof v === 'string') {
			out.set(p, v);
		} else if (Array.isArray(v)) {
			v.forEach((x, i) => walk(x, `${p}[${i}]`));
		} else if (isObj(v)) {
			for (const [k, x] of Object.entries(v)) {
				walk(x, p ? `${p}.${k}` : k);
			}
		}
	};
	walk(doc, '');
	return out;
}

export function dottedPath(path: (string | number)[]): string {
	return path.reduce<string>((acc, k) => (typeof k === 'number' ? `${acc}[${k}]` : acc ? `${acc}.${k}` : String(k)), '');
}

const words = (s: string) => new Set(s.toLowerCase().match(/\p{L}{3,}/gu) ?? []);
const segments = (p: string) => p.replace(/\[\d+\]/g, '').split('.');

/**
 * Choose already-approved translations of the same file that sit closest to the strings being translated
 * (same section of the key tree, shared vocabulary). They show the model the product's terminology and tone.
 */
export function pickReferences(
	sourceDoc: unknown,
	targetDoc: unknown,
	items: { keyPath: string; text: string }[],
	limit = 20,
): RefPair[] {
	if (!sourceDoc || !targetDoc || limit <= 0) {
		return [];
	}
	const src = flattenStrings(sourceDoc);
	const tgt = flattenStrings(targetDoc);
	const itemKeys = new Set(items.map((i) => i.keyPath));
	const itemSegs = items.map((i) => segments(i.keyPath));
	const itemWords = new Set<string>();
	for (const i of items) {
		for (const w of words(i.text)) {
			itemWords.add(w);
		}
	}

	const scored: { pair: RefPair; score: number }[] = [];
	for (const [key, s] of src) {
		const t = tgt.get(key);
		if (t === undefined || t.trim() === '' || t === s || itemKeys.has(key) || s.length > 220 || s.trim() === '') {
			continue;
		}
		const segs = segments(key);
		let prefix = 0;
		for (const is of itemSegs) {
			let n = 0;
			while (n < segs.length && n < is.length && segs[n] === is[n]) {
				n++;
			}
			prefix = Math.max(prefix, n);
		}
		const sw = words(s);
		const shared = [...sw].filter((w) => itemWords.has(w)).length;
		const overlap = sw.size ? shared / sw.size : 0;
		// shared vocabulary matters most for consistent terminology, then living in the same section of the key tree
		scored.push({ pair: { key, source: s, target: t }, score: prefix * 2 + shared * 3 + overlap * 2 });
	}
	scored.sort((a, b) => b.score - a.score || a.pair.source.length - b.pair.source.length);
	const top = scored.filter((x) => x.score > 0).slice(0, limit);
	// when little is related, a few short general examples still convey the tone
	if (top.length < Math.ceil(limit / 2)) {
		const extra = scored.filter((x) => x.score <= 0).slice(0, Math.ceil(limit / 2) - top.length);
		top.push(...extra);
	}
	return top.map((x) => x.pair);
}
