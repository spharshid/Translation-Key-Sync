// {{name}}, {name}, {"json": 1}, %s / %d, $t(key), <b>, </b>, <Name>, &nbsp;
export const PLACEHOLDER_RE = /\{\{[^}]*\}\}|\{[^{}]*\}|%[sdif]|\$t\([^)]*\)|<\/?[a-zA-Z0-9]+[^>]*>|&[a-z]+;/g;

/** Every placeholder-like token in a string, in order. */
export function placeholdersOf(text: string): string[] {
	return text.match(PLACEHOLDER_RE) ?? [];
}

/** Replace placeholders with opaque tokens that machine translators leave alone. */
export function protect(text: string): { masked: string; tokens: string[] } {
	const tokens: string[] = [];
	// a run of adjacent placeholders (<b>{{name}}</b>) becomes ONE token: separate tokens would run together as
	// __PH0____PH1__ and translators leave stray underscores
	const run = new RegExp('(?:' + PLACEHOLDER_RE.source + ')+', 'g');
	const masked = text.replace(run, (m) => {
		tokens.push(m);
		return `__PH${tokens.length - 1}__`;
	});
	return { masked, tokens };
}

/** Put the original placeholders back; null if any was lost or invented. */
export function restore(text: string, tokens: string[]): string | null {
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
	for (const t of tokens) {
		if (!out.includes(t)) {
			return null;
		}
	}
	return out;
}

/** Same placeholders, same number of each (order may change: word order differs between languages). */
export function samePlaceholders(source: string, output: string): boolean {
	const count = (xs: string[]) => {
		const m = new Map<string, number>();
		for (const x of xs) {
			m.set(x, (m.get(x) ?? 0) + 1);
		}
		return m;
	};
	const a = count(placeholdersOf(source));
	const b = count(placeholdersOf(output));
	return a.size === b.size && [...a].every(([k, n]) => b.get(k) === n);
}
