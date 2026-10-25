import * as fs from 'fs/promises';
import * as path from 'path';
import { applyEdits, modify, parse } from 'jsonc-parser';
import { buildTranslatePrompt, parseJsonReply, PromptItem, RefPair } from './ai/prompt';
import { dottedPath, pickReferences } from './ai/refs';
import { validateTranslation } from './ai/validate';
import { ContextFile, termsIn } from './context';
import { PendingEntry, PendingStore, writtenOf } from './pending';
import { detectFormat, valueAt } from './sync';

/**
 * "Use my own AI chat": no API key, no model access from the IDE needed. The extension writes one prompt that contains
 * everything the automatic engine would send (key paths, approved translations, glossary, rules) for the strings still
 * waiting for a good translation; the user pastes it into whatever AI chat they have (Claude, ChatGPT, Gemini, the IDE's own
 * assistant), copies the JSON reply, and the extension validates and writes it.
 */
export interface Awaiting {
	locale: string;
	items: { id: string; entry: PendingEntry }[];
}

const MAX_ITEMS = 40;

const readJson = async (file: string): Promise<unknown> => {
	try {
		return parse((await fs.readFile(file, 'utf8')).replace(/^﻿/, ''));
	} catch {
		return undefined;
	}
};

export interface ManualPrompt {
	prompt: string;
	awaiting: Awaiting;
	/** strings (all languages) still waiting after this prompt */
	remaining: number;
}

/** The next prompt for the strings still waiting for a good translation, or null when there is nothing to do. */
export async function buildManualPrompt(
	store: PendingStore,
	targetDir: string,
	sourceLocale: string,
	context: ContextFile,
	maxItems = MAX_ITEMS,
): Promise<ManualPrompt | null> {
	const entries = await store.all();
	if (!entries.length) {
		return null;
	}
	const locale = entries[0].locale;
	const chunk = entries.filter((e) => e.locale === locale).slice(0, maxItems);
	const items: PromptItem[] = chunk.map((e, i) => ({ id: `p${i}`, text: e.text, keyPath: dottedPath(e.path) }));

	// a few approved translations per file, so the chat sees the product's terminology and tone
	const refs: RefPair[] = [];
	const files = [...new Set(chunk.map((e) => e.file))];
	for (const file of files) {
		const rel = path.relative(path.join(targetDir, locale), file);
		const src = await readJson(path.join(targetDir, sourceLocale, rel));
		const tgt = await readJson(file);
		const mine = items.filter((_, i) => chunk[i].file === file);
		refs.push(...pickReferences(src, tgt, mine, Math.max(4, Math.floor(20 / files.length))));
	}
	const prompt = buildTranslatePrompt({ sourceLocale, locale, file: files.map((f) => path.basename(f)).join(', '), items, refs: refs.slice(0, 20), context });
	return {
		prompt: `${prompt}\n\n(Reply with the JSON object only. Keep every id exactly as given.)`,
		awaiting: { locale, items: items.map((it, i) => ({ id: it.id, entry: chunk[i] })) },
		remaining: entries.length - chunk.length,
	};
}

export interface ApplyResult {
	applied: number;
	/** strings whose reply failed validation: they stay waiting */
	rejected: { text: string; reply: string; problems: string[] }[];
	/** strings someone changed meanwhile: left alone, no longer tracked */
	dropped: number;
	/** ids the reply did not contain: still waiting */
	missing: number;
}

/** Validate a pasted reply and write the good translations; strings that fail stay in the queue. */
export async function applyManualAnswer(store: PendingStore, awaiting: Awaiting, reply: string, context: ContextFile): Promise<ApplyResult | null> {
	const parsed = parseJsonReply(reply);
	if (!parsed) {
		return null;
	}
	const res: ApplyResult = { applied: 0, rejected: [], dropped: 0, missing: 0 };
	const finished: PendingEntry[] = [];

	const byFile = new Map<string, { entry: PendingEntry; value: string }[]>();
	for (const { id, entry } of awaiting.items) {
		const value = parsed[id];
		if (typeof value !== 'string' || !value.trim()) {
			res.missing++;
			continue;
		}
		const v = validateTranslation(entry.text, value, awaiting.locale, termsIn(entry.text, awaiting.locale, context));
		if (v.hard.length) {
			res.rejected.push({ text: entry.text, reply: value, problems: v.hard });
			continue;
		}
		byFile.set(entry.file, [...(byFile.get(entry.file) ?? []), { entry, value }]);
	}

	for (const [file, list] of byFile) {
		let raw: string;
		try {
			raw = await fs.readFile(file, 'utf8');
		} catch {
			res.dropped += list.length;
			finished.push(...list.map((x) => x.entry));
			continue;
		}
		let bom = '';
		if (raw.startsWith('﻿')) {
			bom = '﻿';
			raw = raw.slice(1);
		}
		const fmt = detectFormat(raw);
		let text = raw;
		for (const { entry, value } of list) {
			if (valueAt(parse(text), entry.path) !== writtenOf(entry)) {
				res.dropped++; // edited by someone else meanwhile: never overwrite
				finished.push(entry);
				continue;
			}
			text = applyEdits(text, modify(text, entry.path, value, { formattingOptions: { eol: fmt.eol, insertSpaces: fmt.insertSpaces, tabSize: fmt.tabSize } }));
			res.applied++;
			finished.push(entry);
		}
		if (text !== raw) {
			await fs.writeFile(file, bom + text, 'utf8');
		}
	}
	await store.remove(finished);
	return res;
}
