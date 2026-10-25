import * as fs from 'fs/promises';
import * as path from 'path';
import { parse } from 'jsonc-parser';
import { flattenStrings } from './ai/refs';
import { samePlaceholders } from './placeholders';

/** Looks up an already-approved translation of exactly this source text; undefined when there is none or it is ambiguous. */
export type Memory = (locale: string, text: string) => string | undefined;

async function listJson(dir: string, base = dir): Promise<string[]> {
	let entries: import('fs').Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const out: string[] = [];
	for (const e of entries) {
		const full = path.join(dir, e.name);
		if (e.isDirectory()) {
			if (!e.name.startsWith('.') && e.name !== 'node_modules') {
				out.push(...(await listJson(full, base)));
			}
		} else if (e.name.endsWith('.json')) {
			out.push(path.relative(base, full).split(path.sep).join('/'));
		}
	}
	return out;
}

const read = async (file: string): Promise<unknown> => {
	try {
		return parse((await fs.readFile(file, 'utf8')).replace(/^﻿/, ''));
	} catch {
		return undefined;
	}
};

const norm = (s: string) => s.trim();

/**
 * Translation memory built from the translations that already exist: every (source text -> translation) pair found at the
 * same key in the base-language and the target-language file. Reusing a translation that was already approved for exactly the
 * same text is both free and the most consistent thing to do ("Cancel", "Are you sure?", ...).
 *
 * Rules that keep it safe:
 *  - untranslated values (same as the source or empty) are not memory;
 *  - placeholders must match;
 *  - when the same text was translated differently in different places, the most common wording wins only if it is clearly
 *    dominant (at least twice as frequent); otherwise the string is left to the translator;
 *  - `exclude` lists files/keys that are themselves unconfirmed (English placeholders, machine translations awaiting an AI redo).
 */
export async function buildMemory(
	targetDir: string,
	locales: string[],
	sourceLocale: string,
	exclude: Set<string> = new Set(),
): Promise<Memory> {
	const byLocale = new Map<string, Map<string, Map<string, number>>>();
	const baseDir = path.join(targetDir, sourceLocale);
	for (const rel of await listJson(baseDir)) {
		const src = await read(path.join(baseDir, rel));
		if (!src) {
			continue;
		}
		const srcStrings = flattenStrings(src);
		for (const locale of locales.filter((l) => l !== sourceLocale)) {
			const file = path.join(targetDir, locale, rel);
			const tgt = await read(file);
			if (!tgt) {
				continue;
			}
			const tgtStrings = flattenStrings(tgt);
			const memory = byLocale.get(locale) ?? new Map<string, Map<string, number>>();
			byLocale.set(locale, memory);
			for (const [key, s] of srcStrings) {
				const t = tgtStrings.get(key);
				if (t === undefined || !t.trim() || norm(t) === norm(s) || !/\p{L}/u.test(s) || exclude.has(`${path.resolve(file)}::${key}`) || !samePlaceholders(s, t)) {
					continue;
				}
				const counts = memory.get(norm(s)) ?? new Map<string, number>();
				counts.set(t, (counts.get(t) ?? 0) + 1);
				memory.set(norm(s), counts);
			}
		}
	}
	return (locale, text) => {
		const counts = byLocale.get(locale)?.get(norm(text));
		if (!counts) {
			return undefined;
		}
		const ranked = [...counts].sort((a, b) => b[1] - a[1]);
		if (ranked.length > 1 && ranked[0][1] < ranked[1][1] * 2) {
			return undefined; // genuinely ambiguous
		}
		return samePlaceholders(text, ranked[0][0]) ? ranked[0][0] : undefined;
	};
}
