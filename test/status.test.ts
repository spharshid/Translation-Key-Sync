import * as path from 'node:path';
import { Issue } from '../src/issues';
import type { PendingEntry } from '../src/pending';
import type { ScanResult } from '../src/syncSource';
import { renderStatus, StatusData } from '../src/statusView';
import { assert, done, scenario } from './helper';

const dir = path.join(path.sep, 'repo', 'locales');
const file = (l: string, rel: string) => path.join(dir, l, rel);
const scan = (o: Partial<ScanResult> = {}): ScanResult => ({ missing: [], outdated: [], issues: [], files: 3, ...o });
const data = (o: Partial<StatusData> = {}): StatusData => ({ configured: true, roots: [dir], pending: [], at: Date.now(), ...o });
const entry = (locale: string, p: string[], kind: PendingEntry['kind'] = 'english'): PendingEntry => ({ file: file(locale, 'common.json'), path: p, text: 'T', locale, since: Date.now() - 5 * 60_000, kind });

(async () => {
	await scenario('nothing to report: says so, with the number of files checked', () => {
		const { html } = renderStatus(data({ scan: scan() }));
		assert.match(html, /Every key of the base language exists in every language \(3 files checked\)/);
		assert.match(html, /No broken files/);
		assert.match(html, /Nothing is waiting/);
	});

	await scenario('missing keys are grouped by language and file, counted, and link to the file', () => {
		const r = renderStatus(
			data({
				scan: scan({
					missing: [
						{ locale: 'es', rel: 'common.json', file: file('es', 'common.json'), keys: ['a.b', 'c'] },
						{ locale: 'es', rel: 'menu.json', file: file('es', 'menu.json'), keys: ['m'] },
						{ locale: 'fr', rel: 'common.json', file: file('fr', 'common.json'), keys: ['c'] },
					],
				}),
			}),
		);
		assert.match(r.html, /<b>es<\/b> — 3 keys in 2 files/);
		assert.match(r.html, /<b>fr<\/b> — 1 key in 1 file/);
		assert.match(r.html, /<code>a\.b<\/code>/);
		assert.match(r.html, /<div class="n">4<\/div><div>not translated yet/);
		assert.equal(r.targets.length, 3);
		assert.equal(r.targets[0].file, file('es', 'common.json'));
	});

	await scenario('problems say what is wrong and where, and the file was not changed', () => {
		const issues: Issue[] = [
			{ file: file('es', 'common.json'), rel: 'common.json', locale: 'es', kind: 'invalid-json', message: 'CloseBraceExpected', line: 12 },
			{ file: file('fr', 'common.json'), rel: 'common.json', locale: 'fr', kind: 'structure', message: '"text" is a group of keys here, but the base language has a text', key: 'text' },
		];
		const r = renderStatus(data({ scan: scan({ issues }) }));
		assert.match(r.html, /Invalid JSON/);
		assert.match(r.html, /line 12: CloseBraceExpected/);
		assert.match(r.html, /Structure differs from the base language/);
		assert.match(r.html, /<code>text<\/code>/);
		assert.match(r.html, /not changed/);
		assert.equal(r.targets[0].line, 12);
		assert.match(r.html, /<div class="n">2<\/div><div>problems to fix/);
	});

	await scenario('waiting strings: English placeholders and machine translations are listed separately, per language, with the key as a link', () => {
		const r = renderStatus(data({ scan: scan(), pending: [entry('es', ['buttons', 'save']), entry('es', ['x'], 'lowconf'), entry('fr', ['y'])] }));
		assert.match(r.html, /Written in English for now/);
		assert.match(r.html, /Machine-translated/);
		assert.match(r.html, /buttons\.save/);
		assert.match(r.html, /5 min ago/);
		assert.match(r.html, /<div class="n">2<\/div><div>waiting for a translator/);
		assert.deepEqual(r.targets.find((t) => t.keyPath?.[0] === 'buttons')?.keyPath, ['buttons', 'save']);
	});

	await scenario('long lists are capped, and nothing from a file is ever injected as HTML', () => {
		const keys = Array.from({ length: 250 }, (_, i) => `k${i}`);
		const r = renderStatus(
			data({
				scan: scan({
					missing: [{ locale: 'es', rel: 'c.json', file: file('es', 'c.json'), keys }],
					issues: [{ file: file('es', 'c.json'), rel: 'c.json', locale: 'es', kind: 'structure', message: '<img src=x onerror=alert(1)>', key: '<b>k</b>' }],
				}),
				lastError: { at: Date.now(), message: '<script>x</script>' },
			}),
		);
		assert.match(r.html, /and 150 more/);
		assert.ok(!r.html.includes('<img'), 'message is escaped');
		assert.ok(!r.html.includes('<script>'), 'error text is escaped');
		assert.ok(!r.html.includes('<b>k</b>'), 'key is escaped');
		assert.match(r.html, /The last sync failed/);
	});

	await scenario('the last sync is summarised: which models and services made the strings', () => {
		const withInfo = renderStatus(data({ scan: scan(), lastSync: { at: Date.now() - 3 * 60_000, text: 'translated by gemini-3.6-flash 12, translation memory 3' } })).html;
		assert.match(withInfo, /Last sync that translated something \(3 min ago\): <b>translated by gemini-3\.6-flash 12, translation memory 3<\/b>/);
		assert.ok(!renderStatus(data({ scan: scan() })).html.includes('Last sync that translated'), 'nothing to show before the first sync');
		const hostile = renderStatus(data({ scan: scan(), lastSync: { at: Date.now(), text: '<img src=x onerror=alert(1)>' } })).html;
		assert.ok(!hostile.includes('<img'), 'escaped');
	});

	await scenario('not configured: asks to set up instead of showing empty lists', () => {
		const { html } = renderStatus(data({ configured: false }));
		assert.match(html, /Set up the destination folder/);
		assert.ok(!html.includes('Problems to fix'));
	});

	done();
})();
