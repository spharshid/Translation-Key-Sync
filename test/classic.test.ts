// File handling and failure modes of the machine-translation fallback path (Hugging Face Space + Google).
import * as path from 'node:path';
import { Journal } from '../src/journal';
import { PendingStore, retryPending } from '../src/pending';
import { SnapshotStore } from '../src/snapshot';
import { verifyFile } from '../src/sync';
import { syncCommit } from '../src/syncCommit';
import { chunkText, ProviderHealth } from '../src/translator';
import { Stubs, crlf, json, makeRepo, makeService, readJson, startStubs, tmp, R, W } from './fixtures';
import { assert, done, scenario } from './helper';

const log = () => undefined;
const EOL_CRLF_ONLY = (t: string) => t.includes('\r\n') && !/[^\r]\n/.test(t);

(async () => {
	const stubs: Stubs = await startStubs();

	function world(locales = ['en', 'es']) {
		stubs.reset();
		const root = tmp();
		const repo = makeRepo(path.join(root, 'SourceRepo'));
		const srcDir = path.join(repo.dir, 'locales', 'en');
		const dstDir = path.join(root, 'DestinationRepo', 'locales');
		const pending = new PendingStore(path.join(root, 'pending.json'));
		const cfg = { sourceDir: srcDir, destinations: [{ path: dstDir, mode: 'translate' as const, enabled: true }], locales, sourceLocale: 'en' };
		const health = new ProviderHealth();
		return {
			repo,
			srcDir,
			dstDir,
			pending,
			dst: (l: string, rel: string) => path.join(dstDir, l, rel),
			run: (from: string, to: string, o: { provider?: 'auto' | 'backend' | 'google'; budgetMs?: number } = {}) =>
				syncCommit(cfg, { makeService: async () => makeService(stubs, { provider: o.provider ?? 'google', budgetMs: o.budgetMs, health }), pending }, 'git', repo.dir, from, to, log),
		};
	}

	// ---------------------------------------------------------------- file handling

	await scenario('modify: add/change/delete keys, nested, dotted key, boolean, array; CRLF and 4-space indent kept', async () => {
		const w = world();
		const base = '{\n    "save": "Save",\n    "gone": "Remove me",\n    "a.b.c": "dotted",\n    "n": { "x": "X" },\n    "flag": false\n}\n';
		W(path.join(w.srcDir, 'common.json'), crlf(base));
		const c1 = w.repo.commit('one');
		for (const l of ['en', 'es']) {
			W(w.dst(l, 'common.json'), crlf(base.replace('Save', l === 'es' ? 'Guardar' : 'Save')));
		}
		W(path.join(w.srcDir, 'common.json'), crlf('{\n    "save": "Save now",\n    "a.b.c": "dotted2",\n    "n": { "x": "X", "y": "Why" },\n    "flag": true,\n    "list": ["One", "Two"]\n}\n'));
		const c2 = w.repo.commit('two');
		const st = await w.run(c1, c2);
		const es = readJson(w.dst('es', 'common.json'));
		assert.match(es.save, /^g\|es\|/);
		assert.match(es['a.b.c'], /^g\|es\|/);
		assert.match(es.n.y, /^g\|es\|/);
		assert.equal(es.flag, true);
		assert.equal(es.list.length, 2);
		assert.ok(!('gone' in es));
		assert.ok(EOL_CRLF_ONLY(R(w.dst('es', 'common.json'))));
		assert.ok(/^ {4}"save"/m.test(R(w.dst('es', 'common.json'))));
		assert.equal(readJson(w.dst('en', 'common.json')).save, 'Save now', 'source language copied untranslated');
		assert.equal(st.pending, 0);
	});

	await scenario('new file from scratch (in a sub-folder): created in every locale with all keys, CRLF and the source indent', async () => {
		const w = world(['en', 'es', 'ta']);
		const c1 = w.repo.commit('empty');
		W(path.join(w.srcDir, 'dev/fresh.json'), crlf(json({ title: 'Dashboard', grp: { a: 'A thing', b: 'B thing' } }).replace(/ {2}/g, '\t')));
		const c2 = w.repo.commit('add');
		const st = await w.run(c1, c2);
		assert.equal(st.created, 3);
		for (const l of ['en', 'es', 'ta']) {
			const t = R(w.dst(l, 'dev/fresh.json'));
			assert.equal(Object.keys(JSON.parse(t)).length, 2);
			assert.ok(EOL_CRLF_ONLY(t), `${l}: CRLF`);
			assert.ok(/^\t"title"/m.test(t), `${l}: tab indent from the source`);
		}
	});

	await scenario('a changed file whose target copy is missing is created whole (not just the changed keys)', async () => {
		const w = world();
		W(path.join(w.srcDir, 'm.json'), json({ a: 'Apple', b: 'Banana' }));
		const c1 = w.repo.commit('one');
		W(w.dst('en', 'm.json'), json({ a: 'Apple', b: 'Banana' }));
		W(path.join(w.srcDir, 'm.json'), json({ a: 'Apple', b: 'Banana split' }));
		const c2 = w.repo.commit('two');
		await w.run(c1, c2);
		assert.deepEqual(Object.keys(readJson(w.dst('es', 'm.json'))), ['a', 'b']);
	});

	await scenario('deleted source file is skipped (targets untouched); delete + re-create later creates all strings; rename creates the new name', async () => {
		const w = world();
		W(path.join(w.srcDir, 'd.json'), json({ k: 'Key' }));
		const c1 = w.repo.commit('one');
		W(w.dst('es', 'd.json'), json({ k: 'Llave' }));
		fs_rm(path.join(w.srcDir, 'd.json'));
		const c2 = w.repo.commit('del');
		assert.equal((await w.run(c1, c2)).files, 0);
		assert.deepEqual(readJson(w.dst('es', 'd.json')), { k: 'Llave' });
		W(path.join(w.srcDir, 'd.json'), json({ k: 'Key', z: 'Zed' }));
		const c3 = w.repo.commit('recreate');
		await w.run(c2, c3);
		assert.deepEqual(Object.keys(readJson(w.dst('es', 'd.json'))), ['k', 'z']);
		W(path.join(w.srcDir, 'old.json'), json({ k: 'Key' }));
		const c4 = w.repo.commit('old');
		sh_mv(w.repo.dir, 'locales/en/old.json', 'locales/en/new.json');
		const c5 = w.repo.commit('rename');
		await w.run(c4, c5);
		assert.ok(readJson(w.dst('es', 'new.json')).k);
	});

	await scenario('a whitespace-only reformat of the source writes nothing', async () => {
		const w = world();
		W(path.join(w.srcDir, 'w.json'), '{"k":"Key"}\n');
		const c1 = w.repo.commit('one');
		W(w.dst('es', 'w.json'), '{"k":"Llave"}\n');
		W(w.dst('en', 'w.json'), '{"k":"Key"}\n');
		W(path.join(w.srcDir, 'w.json'), '{\n  "k": "Key"\n}\n');
		const c2 = w.repo.commit('fmt');
		assert.equal((await w.run(c1, c2)).files, 0);
		assert.equal(R(w.dst('es', 'w.json')), '{"k":"Llave"}\n');
	});

	await scenario('byte-order marks in source and target are handled and kept', async () => {
		const w = world();
		W(path.join(w.srcDir, 'b.json'), '﻿{ "k": "Key" }\n');
		const c1 = w.repo.commit('one');
		W(w.dst('es', 'b.json'), '﻿{ "k": "Llave" }\n');
		W(path.join(w.srcDir, 'b.json'), '﻿{ "k": "Key", "m": "More" }\n');
		const c2 = w.repo.commit('two');
		await w.run(c1, c2);
		const t = R(w.dst('es', 'b.json'));
		assert.ok(t.startsWith('﻿'));
		assert.match(JSON.parse(t.slice(1)).m, /^g\|es\|/);
	});

	await scenario('multi-line strings are translated line by line, placeholders/HTML/JSON snippets survive, empty strings kept', async () => {
		const w = world();
		W(path.join(w.srcDir, 'n.json'), json({ k: 'x' }));
		const c1 = w.repo.commit('one');
		const v = { t: 'First line.\nSecond line.\r\nThird', a: 'A minimum of {{min}} characters', b: 'Escalation: <Name>', c: 'e.g. {"currency_type": "USD"}.', d: '', e: 'Use %s items' };
		W(path.join(w.srcDir, 'n.json'), json({ k: 'x', ...v }));
		const c2 = w.repo.commit('two');
		await w.run(c1, c2);
		const es = readJson(w.dst('es', 'n.json'));
		assert.equal(es.t.split(/\r?\n/).length, 3);
		assert.ok(es.a.includes('{{min}}') && es.b.includes('<Name>') && es.c.includes('{"currency_type": "USD"}') && es.e.includes('%s'));
		assert.equal(es.d, '');
	});

	// ---------------------------------------------------------------- failure modes of the machine translators

	await scenario('Space asleep, wakes while the sync runs: Google covers the gap, nothing is English', async () => {
		const w = world();
		W(path.join(w.srcDir, 'a.json'), json({ base: 'x' }));
		const c1 = w.repo.commit('one');
		stubs.st.bMode = 'asleep503';
		stubs.st.gDelay = 120;
		const keys: Record<string, string> = { base: 'x' };
		for (let i = 0; i < 20; i++) {keys['k' + i] = `Value number ${i} saved`;}
		W(path.join(w.srcDir, 'a.json'), json(keys));
		const c2 = w.repo.commit('two');
		const wake = setTimeout(() => (stubs.st.bMode = 'ok'), 1500);
		const st = await w.run(c1, c2, { provider: 'auto' });
		clearTimeout(wake); // must not leak into the next scenario
		const es = readJson(w.dst('es', 'a.json'));
		assert.ok(Object.values(es).every((x) => /^(b|g)\|es\|/.test(x as string)));
		assert.equal(st.pending, 0);
		assert.ok(stubs.st.g > 0);
	});

	await scenario('Space returns a "starting" page with HTTP 200 / hangs / sends garbage: treated as asleep, Google used', async () => {
		for (const mode of ['asleep200', 'hang', 'garbage'] as const) {
			const w = world();
			W(path.join(w.srcDir, 'a.json'), json({ base: 'x' }));
			const c1 = w.repo.commit('one');
			stubs.st.bMode = mode;
			W(path.join(w.srcDir, 'a.json'), json({ base: 'x', k: 'Value saved' }));
			const c2 = w.repo.commit('two');
			const st = await w.run(c1, c2, { provider: 'auto' });
			assert.match(readJson(w.dst('es', 'a.json')).k, /^g\|es\|/, mode + ' got ' + JSON.stringify(readJson(w.dst('es', 'a.json'))) + ' g=' + stubs.st.g + ' b=' + stubs.st.b);
			assert.equal(st.pending, 0, mode + ' ' + JSON.stringify(st) + ' g=' + stubs.st.g + ' b=' + stubs.st.b);
		}
	});

	await scenario('Google blocks the first requests (429) then recovers, Space down: retries with backoff until everything is translated', async () => {
		const w = world();
		W(path.join(w.srcDir, 'a.json'), json({ base: 'x' }));
		const c1 = w.repo.commit('one');
		stubs.st.bMode = 'asleep503';
		stubs.st.gBlockFirst = 6;
		const keys: Record<string, string> = { base: 'x' };
		for (let i = 0; i < 8; i++) {keys['k' + i] = `Value number ${i} saved`;}
		W(path.join(w.srcDir, 'a.json'), json(keys));
		const c2 = w.repo.commit('two');
		const st = await w.run(c1, c2, { provider: 'auto' });
		assert.ok(Object.values(readJson(w.dst('es', 'a.json'))).every((x) => /^g\|es\|/.test(x as string)));
		assert.equal(st.pending, 0);
	});

	await scenario('both services down for the whole budget: every key is still written (English), queued, then healed; a hand edit is kept', async () => {
		const w = world();
		W(path.join(w.srcDir, 'a.json'), json({ base: 'x' }));
		const c1 = w.repo.commit('one');
		stubs.st.bMode = 'asleep503';
		stubs.st.gMode = 'block429';
		const keys: Record<string, string> = { base: 'x' };
		for (let i = 0; i < 8; i++) {keys['k' + i] = `Value number ${i} saved`;}
		W(path.join(w.srcDir, 'a.json'), json(keys));
		const c2 = w.repo.commit('two');
		const st = await w.run(c1, c2, { provider: 'auto', budgetMs: 1200 });
		assert.equal(st.pending, 9);
		assert.equal(readJson(w.dst('es', 'a.json')).k3, 'Value number 3 saved');
		const f = w.dst('es', 'a.json');
		W(f, R(f).replace('Value number 3 saved', 'Mi texto manual'));
		stubs.reset();
		const r = await retryPending(w.pending, makeService(stubs, { aiWanted: false, provider: 'auto' }), log);
		assert.equal(r.remaining, 0);
		assert.equal(r.dropped, 1);
		const healed = readJson(f);
		assert.equal(healed.k3, 'Mi texto manual');
		assert.ok(/^(b|g)\|es\|/.test(healed.k0));
		assert.equal(await w.pending.count(), 0);
	});

	await scenario('the time budget holds with many strings (40 strings, both down, 600 ms)', async () => {
		const w = world();
		W(path.join(w.srcDir, 'a.json'), json({ base: 'x' }));
		const c1 = w.repo.commit('one');
		stubs.st.bMode = 'asleep503';
		stubs.st.gMode = 'block429';
		const keys: Record<string, string> = { base: 'x' };
		for (let i = 0; i < 40; i++) {keys['k' + i] = `Value number ${i} saved`;}
		W(path.join(w.srcDir, 'a.json'), json(keys));
		const c2 = w.repo.commit('two');
		const t = Date.now();
		const st = await w.run(c1, c2, { provider: 'auto', budgetMs: 600 });
		assert.ok(Date.now() - t < 5000);
		assert.equal(st.pending, 41);
		assert.equal(Object.keys(readJson(w.dst('es', 'a.json'))).length, 41);
	});

	await scenario('provider "backend" only: waits for the Space to wake and never calls Google', async () => {
		const w = world();
		W(path.join(w.srcDir, 'a.json'), json({ base: 'x' }));
		const c1 = w.repo.commit('one');
		stubs.st.bMode = 'asleep503';
		W(path.join(w.srcDir, 'a.json'), json({ base: 'x', k: 'Value saved' }));
		const c2 = w.repo.commit('two');
		setTimeout(() => (stubs.st.bMode = 'ok'), 800);
		await w.run(c1, c2, { provider: 'backend' });
		assert.match(readJson(w.dst('es', 'a.json')).k, /^b\|es\|/);
		assert.equal(stubs.st.g, 0);
	});

	await scenario('long strings are chunked for both machine translators and nothing is lost', async () => {
		const long = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
		assert.ok(chunkText(long, 220).every((c) => c.length <= 220));
		assert.equal(chunkText(long, 220).join(' '), long);
		const w = world();
		W(path.join(w.srcDir, 'a.json'), json({ base: 'x' }));
		const c1 = w.repo.commit('one');
		W(path.join(w.srcDir, 'a.json'), json({ base: 'x', long }));
		const c2 = w.repo.commit('two');
		await w.run(c1, c2, { provider: 'backend' });
		const out: string = readJson(w.dst('es', 'a.json')).long;
		assert.equal((out.match(/b\|es\|/g) ?? []).length, chunkText(long, 220).length);
	});

	// ---------------------------------------------------------------- small units

	await scenario('verifyFile catches a missing / wrong value or invalid JSON', async () => {
		const root = tmp();
		const f = path.join(root, 'x.json');
		W(f, '{ "a": "1" }');
		assert.equal(await verifyFile(f, new Map<any, unknown>([[{ path: ['a'], value: '1' }, '1']])), 1);
		await assert.rejects(() => verifyFile(f, new Map<any, unknown>([[{ path: ['a'] }, '2']])), /verification failed/);
		await assert.rejects(() => verifyFile(f, new Map<any, unknown>([[{ path: ['b'] }, 'x']])), /verification failed/);
		W(f, '{ "a": ');
		await assert.rejects(() => verifyFile(f, new Map<any, unknown>()), /not valid JSON/);
	});

	await scenario('journal: unfinished syncs are replayed, finished ones are not, and a bad one gives up after 3 tries', async () => {
		const mem = new Map<string, any>();
		const j = new Journal({ get: (k: string, d: any) => mem.get(k) ?? d, update: async (k: string, v: any) => void mem.set(k, v) } as any);
		await j.start({ root: 'r', from: 'a', to: 'b' });
		await j.start({ root: 'r', from: 'b', to: 'c' });
		await j.finish({ root: 'r', from: 'a', to: 'b' });
		assert.deepEqual((await j.takeForReplay()).map((e) => e.to), ['c']);
		await j.takeForReplay();
		await j.takeForReplay();
		assert.deepEqual(await j.takeForReplay(), []);
	});

	await scenario('pending and snapshot stores survive a restart (new instance, same file)', async () => {
		const root = tmp();
		const p = new PendingStore(path.join(root, 'p.json'));
		await p.add([{ file: 'f.json', path: ['a', 0], text: 'T', locale: 'es', since: 1 }]);
		const again = new PendingStore(path.join(root, 'p.json'));
		assert.equal(await again.count(), 1);
		await again.add([{ file: 'f.json', path: ['a', 0], text: 'T2', locale: 'es', since: 2 }]);
		assert.equal((await again.all())[0].text, 'T2');
		const s = new SnapshotStore(path.join(root, 's.json')).scope(path.join(root, 'locales'));
		await s.update('a.json', [{ path: ['k'], value: 'v' }]);
		const s2 = new SnapshotStore(path.join(root, 's.json')).scope(path.join(root, 'locales'));
		assert.ok(await s2.get('a.json', ['k']));
		await s2.update('a.json', [{ path: ['k'], deleted: true }]);
		assert.equal(await s2.get('a.json', ['k']), undefined);
	});

	stubs.close();
	done();
})();

// small helpers kept at the bottom so the scenarios read top to bottom
import * as fs from 'node:fs';
import { sh } from './fixtures';
function fs_rm(f: string) {
	fs.rmSync(f);
}
function sh_mv(cwd: string, from: string, to: string) {
	sh(`git mv ${from} ${to}`, cwd);
}
