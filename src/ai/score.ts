/**
 * chrF-style similarity between a candidate translation and a reference (character n-grams 1..6, F-beta with beta=2,
 * the standard "chrF" setup). 0 = nothing in common, 1 = identical. It is a proxy: a correct translation worded
 * differently scores lower, so compare engines on the same strings rather than reading one number in isolation.
 */
export function chrf(candidate: string, reference: string, maxN = 6, beta = 2): number {
	const norm = (s: string) => s.normalize('NFC').replace(/\s+/g, '');
	const c = norm(candidate);
	const r = norm(reference);
	if (!c.length || !r.length) {
		return c === r ? 1 : 0;
	}
	const grams = (s: string, n: number) => {
		const m = new Map<string, number>();
		for (let i = 0; i + n <= s.length; i++) {
			const g = s.slice(i, i + n);
			m.set(g, (m.get(g) ?? 0) + 1);
		}
		return m;
	};
	let prec = 0;
	let rec = 0;
	let used = 0;
	for (let n = 1; n <= maxN; n++) {
		const cg = grams(c, n);
		const rg = grams(r, n);
		const cTotal = [...cg.values()].reduce((a, b) => a + b, 0);
		const rTotal = [...rg.values()].reduce((a, b) => a + b, 0);
		if (!cTotal || !rTotal) {
			continue;
		}
		let match = 0;
		for (const [g, k] of cg) {
			match += Math.min(k, rg.get(g) ?? 0);
		}
		prec += match / cTotal;
		rec += match / rTotal;
		used++;
	}
	if (!used) {
		return 0;
	}
	prec /= used;
	rec /= used;
	if (prec + rec === 0) {
		return 0;
	}
	const b2 = beta * beta;
	return ((1 + b2) * prec * rec) / (b2 * prec + rec);
}
