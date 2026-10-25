import * as path from 'path';

/**
 * Where a sync writes to:
 *  translate  a folder with one sub-folder per language; every language is translated from the source
 *  copy       a folder that gets the base language as it is (for example a fallback copy in another repo)
 */
export type DestinationMode = 'translate' | 'copy';

export interface Destination {
	path: string;
	mode: DestinationMode;
	/** ticked: included when syncing */
	enabled: boolean;
}

/** The destinations of a settings value, with anything malformed left out. `resolve` expands things like `~/`. */
export function parseDestinations(raw: unknown, resolve: (p: string) => string = (p) => p): Destination[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const out: Destination[] = [];
	for (const r of raw) {
		const d = r as Partial<Destination> | null;
		const p = typeof d?.path === 'string' ? resolve(d.path) : '';
		if (p) {
			out.push({ path: p, mode: d?.mode === 'copy' ? 'copy' : 'translate', enabled: d?.enabled !== false });
		}
	}
	return out;
}

/** The folder that holds the locale sub-folders: the first "translate" destination (context file, memory, status page). */
export function localesDirOf(destinations: Destination[]): string {
	return destinations.find((d) => d.mode === 'translate')?.path ?? '';
}

const same = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** The files a destination holds for one source file (relative path `rel`), minus the source file itself. */
export function targetsOf(d: Destination, locales: string[], sourceLocale: string, rel: string, sourceFile: string): { locale: string; file: string }[] {
	const all = d.mode === 'copy' ? [{ locale: sourceLocale, file: path.join(d.path, rel) }] : locales.map((locale) => ({ locale, file: path.join(d.path, locale, rel) }));
	return all.filter((t) => !same(t.file, sourceFile));
}

/** Is `file` inside `dir`? */
export function isInside(dir: string, file: string): boolean {
	const r = path.relative(path.resolve(dir), path.resolve(file));
	return !r.startsWith('..') && !path.isAbsolute(r);
}

/** One line for a prompt or a hint, e.g. "translate into es, fr" or "copy as is". */
export function describeDestination(d: Destination, locales: string[], sourceLocale: string): string {
	if (d.mode === 'copy') {
		return `${sourceLocale} copied as it is`;
	}
	const others = locales.filter((l) => l !== sourceLocale);
	return others.length ? `translate into ${others.join(', ')}` : 'translate';
}
