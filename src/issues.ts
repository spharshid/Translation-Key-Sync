import { parse, ParseError, printParseErrorCode } from 'jsonc-parser';
import type { KeyPath } from './sync';

/** Something that stopped a file or a key from being synced. The file is left exactly as it was. */
export interface Issue {
	/** absolute path of the locale file */
	file: string;
	/** path of the file relative to its locale folder */
	rel: string;
	locale: string;
	kind: 'invalid-json' | 'structure';
	message: string;
	/** 1-based line of the syntax error (invalid-json) */
	line?: number;
	/** dotted path of the key (structure) */
	key?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const typeName = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : `a ${typeof v}`);

/** The first syntax error of a JSON text (trailing commas are tolerated, as when writing), or undefined when it is fine. */
export function jsonProblem(raw: string): { message: string; line: number } | undefined {
	if (!raw.trim()) {
		return undefined; // an empty file is treated as an empty object
	}
	const errors: ParseError[] = [];
	const doc = parse(raw.replace(/^﻿/, ''), errors, { allowTrailingComma: true });
	if (errors.length) {
		const e = errors[0];
		return { message: printParseErrorCode(e.error), line: raw.slice(0, e.offset).split('\n').length };
	}
	return doc !== undefined && !isObj(doc) ? { message: `the file must contain a JSON object, not ${typeName(doc)}`, line: 1 } : undefined;
}

/**
 * Would writing a source-language leaf at `p` clash with what the locale file already holds there?
 * A text where the source has a group (or the other way round) would otherwise be overwritten or break the file.
 */
export function structureProblem(doc: unknown, p: KeyPath): string | undefined {
	let cur: unknown = doc;
	for (let i = 0; i < p.length; i++) {
		if (cur === undefined) {
			return undefined;
		}
		if (!isObj(cur)) {
			return `"${p.slice(0, i).join('.')}" is ${typeName(cur)} here, but the base language has a group of keys under it`;
		}
		cur = cur[String(p[i])];
	}
	return isObj(cur) ? `"${p.join('.')}" is a group of keys here, but the base language has a text` : undefined;
}

/** Add an issue unless the same one is already listed. */
export function addIssue(list: Issue[], issue: Issue) {
	if (!list.some((x) => x.file === issue.file && x.kind === issue.kind && x.key === issue.key)) {
		list.push(issue);
	}
}
