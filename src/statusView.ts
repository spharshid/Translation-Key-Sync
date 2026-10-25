import * as path from 'path';
import type { PendingEntry } from './pending';
import type { ScanEntry, ScanResult } from './syncSource';

export interface StatusData {
	configured: boolean;
	/** the destination folders; file paths are shown relative to the one that holds them */
	roots: string[];
	scan?: ScanResult;
	scanError?: string;
	pending: PendingEntry[];
	lastError?: { at: number; message: string };
	at: number;
	/** false when Sync Locales is set not to translate the other languages */
	syncsLocales?: boolean;
}

/** A file (and place in it) a row of the page can open. The page only ever sends back the index of a row. */
export interface Target {
	file: string;
	line?: number;
	keyPath?: (string | number)[];
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const MAX_KEYS = 100;

const ago = (t: number) => {
	const m = Math.round((Date.now() - t) / 60_000);
	return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/** The page body for a set of data, and the places its links open. Pure, so it can be tested without VS Code. */
export function renderStatus(d: StatusData): { html: string; targets: Target[] } {
	const targets: Target[] = [];
	const link = (label: string, t: Target) => `<a href="#" data-open="${targets.push(t) - 1}">${esc(label)}</a>`;
	const rel = (file: string) => {
		const root = d.roots.find((r) => !path.relative(r, file).startsWith('..'));
		return root ? path.relative(root, file).split(path.sep).join('/') : file;
	};
	const out: string[] = [];

	if (!d.configured) {
		return { html: '<p class="empty">Set up the destination folder and languages first (<b>i18n AI Translate &amp; Sync: Configure</b>).</p>', targets };
	}
	if (d.lastError) {
		out.push(`<div class="banner err"><b>The last sync failed</b> (${esc(ago(d.lastError.at))}): ${esc(d.lastError.message)}<br>Nothing is lost: the commit is tried again when VS Code starts, and <b>Sync Locales</b> picks up anything missing.</div>`);
	}
	if (d.scanError) {
		out.push(`<div class="banner err">Could not check the locale files: ${esc(d.scanError)}</div>`);
	}

	const scan = d.scan;
	const missingKeys = scan?.missing.reduce((n, e) => n + e.keys.length, 0) ?? 0;
	const outdatedKeys = scan?.outdated.reduce((n, e) => n + e.keys.length, 0) ?? 0;
	const english = d.pending.filter((e) => e.kind !== 'lowconf');
	const machine = d.pending.filter((e) => e.kind === 'lowconf');
	const problems = scan?.issues ?? [];

	const card = (n: number, label: string, bad: boolean) => `<div class="card ${n && bad ? 'warn' : ''}"><div class="n">${n}</div><div>${esc(label)}</div></div>`;
	out.push(
		`<div class="cards">${card(missingKeys + outdatedKeys, 'not translated yet', true)}${card(english.length, 'waiting for a translator', true)}${card(machine.length, 'machine-translated, AI will redo', false)}${card(problems.length, 'problems to fix', true)}</div>`,
	);

	const keyList = (keys: string[]) => {
		const shown = keys.slice(0, MAX_KEYS).map((k) => `<li><code>${esc(k)}</code></li>`);
		return `<ul>${shown.join('')}${keys.length > MAX_KEYS ? `<li>… and ${keys.length - MAX_KEYS} more</li>` : ''}</ul>`;
	};
	const byLocale = <T extends { locale: string }>(list: T[]) => {
		const m = new Map<string, T[]>();
		for (const e of list) {
			m.set(e.locale, [...(m.get(e.locale) ?? []), e]);
		}
		return [...m].sort(([a], [b]) => a.localeCompare(b));
	};

	// ---- problems
	out.push('<h2>Problems to fix</h2>');
	if (!problems.length) {
		out.push('<p class="empty">No broken files.</p>');
	} else {
		out.push('<p class="hint">These files were <b>not changed</b>. Fix them, then press <b>Rescan</b> or <b>Sync Locales</b>.</p><table><tr><th>Language</th><th>File</th><th>Problem</th></tr>');
		for (const i of problems) {
			const where = i.kind === 'invalid-json' ? `line ${i.line}: ${i.message}` : `${i.key ? `<code>${esc(i.key)}</code>: ` : ''}${esc(i.message)}`;
			const what = i.kind === 'invalid-json' ? 'Invalid JSON' : 'Structure differs from the base language';
			out.push(
				`<tr><td>${esc(i.locale)}</td><td>${link(rel(i.file) || i.rel, { file: i.file, line: i.line })}</td><td><b>${what}</b><br>${i.kind === 'invalid-json' ? esc(where) : where}</td></tr>`,
			);
		}
		out.push('</table>');
	}

	// ---- not translated yet
	out.push('<h2>Not translated yet</h2>');
	if (!scan) {
		out.push('<p class="empty">Checking…</p>');
	} else if (!scan.missing.length && !scan.outdated.length) {
		out.push(`<p class="empty">Every key of the base language exists in every language (${plural(scan.files, 'file')} checked).</p>`);
	} else {
		out.push(
			d.syncsLocales === false
				? '<p class="hint">No ticked destination translates into languages (settings: destinations), so Sync Locales will not fill these.</p>'
				: '<p class="hint"><b>Sync Locales</b> translates all of these.</p>',
		);
		const section = (title: string, list: ScanEntry[]) => {
			if (!list.length) {
				return;
			}
			out.push(`<h3>${esc(title)}</h3>`);
			for (const [locale, entries] of byLocale(list)) {
				const n = entries.reduce((c, e) => c + e.keys.length, 0);
				out.push(`<details data-id="${esc(title + locale)}"><summary><b>${esc(locale)}</b> — ${plural(n, 'key')} in ${plural(entries.length, 'file')}</summary>`);
				for (const e of entries) {
					out.push(`<div class="file">${link(e.rel, { file: e.file })}${' '}<span class="hint">${plural(e.keys.length, 'key')}</span></div>${keyList(e.keys)}`);
				}
				out.push('</details>');
			}
		};
		section('Missing', scan.missing);
		section('Base-language text was edited, translation is out of date', scan.outdated);
	}

	// ---- waiting for a translator
	out.push('<h2>Waiting for a translator</h2>');
	if (!d.pending.length) {
		out.push('<p class="empty">Nothing is waiting.</p>');
	} else {
		const section = (title: string, hint: string, list: PendingEntry[]) => {
			if (!list.length) {
				return;
			}
			out.push(`<h3>${esc(title)}</h3><p class="hint">${esc(hint)}</p>`);
			for (const [locale, entries] of byLocale(list)) {
				out.push(`<details data-id="${esc(title + locale)}"><summary><b>${esc(locale)}</b> — ${plural(entries.length, 'string')}</summary><table><tr><th>File</th><th>Key</th><th>Waiting</th></tr>`);
				for (const e of entries.slice(0, MAX_KEYS)) {
					const key = e.path.join('.');
					out.push(`<tr><td>${esc(rel(e.file))}</td><td>${link(key, { file: e.file, keyPath: e.path })}</td><td>${esc(ago(e.since))}</td></tr>`);
				}
				out.push(`</table>${entries.length > MAX_KEYS ? `<p class="hint">… and ${entries.length - MAX_KEYS} more</p>` : ''}</details>`);
			}
		};
		section('Written in English for now', 'No translator answered in time, so the English text is in the file. They are retried automatically every 5 minutes.', english);
		section('Machine-translated', 'Only machine translation was available. The translation is written but less accurate; an AI model redoes it when one is available.', machine);
	}

	out.push(`<p class="hint">Checked ${esc(ago(d.at))}.</p>`);
	return { html: out.join('\n'), targets };
}
