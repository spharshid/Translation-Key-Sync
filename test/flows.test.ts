import * as fs from 'node:fs';
import * as path from 'node:path';
import { LlmClient, LlmError } from '../src/ai/clients';
import { Cancelled } from '../src/cancel';
import { PendingStore, retryPending } from '../src/pending';
import { Destination } from '../src/destinations';
import { SnapshotStore } from '../src/snapshot';
import { newStats } from '../src/sync';
import { SyncConfig, syncCommit } from '../src/syncCommit';
import { scanSource, SyncScope, syncFromSource } from '../src/syncSource';
import { TranslationService } from '../src/translation';
import { FakeClient, Stubs, aiClient, crlf, itemsIn, json, makeRepo, makeService, readJson, sh, startStubs, tmp, R, W } from './fixtures';
import { assert, done, scenario } from './helper';

const LOCALES = ['en', 'es', 'fr'];
const T = (dir: string): Destination => ({ path: dir, mode: 'translate', enabled: true });
const C = (dir: string): Destination => ({ path: dir, mode: 'copy', enabled: true });
const log = () => undefined;

/** A SourceRepo (git), a DestinationRepo (git) with en/es/fr, a snapshot store and a pending store. */
function world() {
	const root = tmp();
	const src = makeRepo(path.join(root, 'SourceRepo'));
	const dst = makeRepo(path.join(root, 'DestinationRepo'));
	const srcDir = path.join(src.dir, 'locales', 'en');
	const dstDir = path.join(dst.dir, 'locales');
	return {
		root,
		src,
		dst,
		srcDir,
		dstDir,
		snapshots: new SnapshotStore(path.join(root, 'snapshot.json')),
		pending: new PendingStore(path.join(root, 'pending.json')),
		/** the on-commit flow: the SourceRepo folder is translated into the DestinationRepo */
		cfg: { sourceDir: srcDir, destinations: [T(dstDir)], locales: LOCALES, sourceLocale: 'en' } as SyncConfig,
		dstFile: (loc: string, rel: string) => path.join(dstDir, loc, rel),
	};
}
type World = ReturnType<typeof world>;

const forward = (w: World, svc: TranslationService, from: string, to: string, withSnapshot = true) =>
	syncCommit(w.cfg, { makeService: async () => svc, pending: w.pending, snapshots: withSnapshot ? w.snapshots : undefined }, 'git', w.src.dir, from, to, log);
/** the Sync Locales flow: the base language inside the DestinationRepo goes to its other languages and, optionally, to the SourceRepo folder as a copy */
const reverseCfg = (w: World, toFallback = false, toLocales = true): SyncConfig => ({
	sourceDir: path.join(w.dstDir, 'en'),
	destinations: [...(toLocales ? [T(w.dstDir)] : []), ...(toFallback ? [C(w.srcDir)] : [])],
	locales: LOCALES,
	sourceLocale: 'en',
});
const reverse = (w: World, svc: TranslationService, toFallback = false, scope: SyncScope = 'all') =>
	syncFromSource(reverseCfg(w, toFallback), { makeService: async () => svc, pending: w.pending, snapshots: w.snapshots }, 'git', log, scope);

/** Destination repo with en/es/fr common.json committed; es also has a key that en lacks. */
function seedDestination(w: World) {
	W(w.dstFile('en', 'common.json'), json({ a: 'Alpha', b: 'Beta' }));
	W(w.dstFile('es', 'common.json'), json({ a: 'es-Alpha', b: 'es-Beta', extra: 'Solo es' }));
	W(w.dstFile('fr', 'common.json'), json({ a: 'fr-Alpha', b: 'fr-Beta' }));
	w.dst.commit('seed');
}

(async () => {
	const stubs: Stubs = await startStubs();

	// ---------------------------------------------------------------- forward flow (SourceRepo commit -> DestinationRepo)

	await scenario('forward: the model gets the key path and nearby approved translations; result written with CRLF kept', async () => {
		stubs.reset();
		const w = world();
		W(path.join(w.srcDir, 'common.json'), crlf(json({ buttons: { save: 'Save' }, errors: { x: 'X failed' } })));
		const c1 = w.src.commit('one');
		W(w.dstFile('es', 'common.json'), crlf(json({ buttons: { save: 'Guardar' }, errors: { x: 'X falló' } })));
		W(w.dstFile('en', 'common.json'), crlf(json({ buttons: { save: 'Save' }, errors: { x: 'X failed' } })));
		W(path.join(w.srcDir, 'common.json'), crlf(json({ buttons: { save: 'Save', cancel: 'Cancel' }, errors: { x: 'X failed' } })));
		const c2 = w.src.commit('two');
		const ai = aiClient();
		const st = await forward(w, makeService(stubs, { ai: [ai] }), c1, c2);
		const es = readJson(w.dstFile('es', 'common.json'));
		assert.equal(es.buttons.cancel, 'ai(Cancel)');
		assert.equal(es.buttons.save, 'Guardar', 'untouched keys keep their approved translation');
		assert.match(ai.prompts[0], /"key":"buttons\.cancel"/);
		assert.match(ai.prompts[0], /"es":"Guardar"/, 'sibling approved translation passed as reference');
		assert.ok(/[^\r]\n/.test(R(w.dstFile('es', 'common.json'))) === false, 'CRLF kept');
		assert.equal(st.pending, 0);
		assert.ok(st.verified > 0);
	});

	await scenario('forward: re-running the same commit does not translate again (snapshot), but works again without a snapshot', async () => {
		stubs.reset();
		const w = world();
		W(path.join(w.srcDir, 'c.json'), json({ a: 'Alpha' }));
		const c1 = w.src.commit('one');
		W(path.join(w.srcDir, 'c.json'), json({ a: 'Alpha', b: 'Beta' }));
		const c2 = w.src.commit('two');
		const ai = aiClient();
		await forward(w, makeService(stubs, { ai: [ai] }), c1, c2);
		const calls = ai.prompts.length;
		const again = await forward(w, makeService(stubs, { ai: [ai] }), c1, c2);
		assert.equal(ai.prompts.length, calls, 'no new requests');
		assert.ok(again.skipped >= 2);
		await forward(w, makeService(stubs, { ai: [ai] }), c1, c2, false);
		assert.ok(ai.prompts.length > calls, 'without a snapshot it translates again');
	});

	await scenario('forward: a changed value IS retranslated even though the key is known', async () => {
		stubs.reset();
		const w = world();
		W(path.join(w.srcDir, 'c.json'), json({ a: 'Alpha' }));
		const c1 = w.src.commit('one');
		const ai = aiClient();
		await forward(w, makeService(stubs, { ai: [ai] }), '4b825dc642cb6eb9a060e54bf8d69288fbee4904', c1); // empty tree -> first sync
		assert.equal(readJson(w.dstFile('es', 'c.json')).a, 'ai(Alpha)');
		W(path.join(w.srcDir, 'c.json'), json({ a: 'Alpha v2' }));
		const c2 = w.src.commit('two');
		await forward(w, makeService(stubs, { ai: [ai] }), c1, c2);
		assert.equal(readJson(w.dstFile('es', 'c.json')).a, 'ai(Alpha v2)');
	});

	await scenario('forward: AI down -> machine translation written and queued for an AI redo; later the AI replaces it; a hand edit is protected', async () => {
		stubs.reset();
		const w = world();
		W(path.join(w.srcDir, 'c.json'), json({ a: 'Alpha' }));
		const c1 = w.src.commit('one');
		W(path.join(w.srcDir, 'c.json'), json({ a: 'Alpha', b: 'Beta', c: 'Gamma' }));
		const c2 = w.src.commit('two');
		const dead = new FakeClient('dead', () => new LlmError('no access', 'unavailable'));
		const st = await forward(w, makeService(stubs, { ai: [dead] }), c1, c2);
		assert.ok(st.machine >= 4, 'machine count ' + st.machine);
		assert.match(readJson(w.dstFile('es', 'c.json')).b, /^g\|es\|/);
		const entries = await w.pending.all();
		assert.ok(entries.length >= 4 && entries.every((e) => e.kind === 'lowconf'));
		// a developer fixes one by hand, then the AI becomes available
		const f = w.dstFile('es', 'c.json');
		W(f, R(f).replace(readJson(f).c, 'Mi texto'));
		const ai = aiClient();
		const r = await retryPending(w.pending, makeService(stubs, { ai: [ai] }), log);
		const es = readJson(f);
		assert.equal(es.b, 'ai(Beta)');
		assert.equal(es.c, 'Mi texto');
		assert.ok(r.dropped === 1 && r.fixed === 5 && r.remaining === 0, JSON.stringify(r));
		assert.equal(await w.pending.count(), 0);
	});

	await scenario('forward: lowconf entries are left alone while the AI is still unavailable (no churn on machine translation)', async () => {
		stubs.reset();
		const w = world();
		W(path.join(w.srcDir, 'c.json'), json({ a: 'Alpha' }));
		const c1 = w.src.commit('one');
		W(path.join(w.srcDir, 'c.json'), json({ a: 'Alpha', b: 'Beta' }));
		const c2 = w.src.commit('two');
		const dead = () => new FakeClient('dead', () => new LlmError('no access', 'unavailable'));
		await forward(w, makeService(stubs, { ai: [dead()] }), c1, c2);
		stubs.st.g = 0;
		const svc = makeService(stubs, { ai: [dead()] });
		const r = await retryPending(w.pending, svc, log);
		assert.equal(r.fixed, 0);
		assert.equal(stubs.st.g, 0, 'did not call the machine translator again');
		assert.ok(r.remaining >= 2);
	});

	await scenario('everything down -> English written + queued; machine translation returns -> better than English but still queued for the AI; AI returns -> final', async () => {
		stubs.reset();
		const w = world();
		W(path.join(w.srcDir, 'c.json'), json({ a: 'Alpha' }));
		const c1 = w.src.commit('one');
		W(path.join(w.srcDir, 'c.json'), json({ a: 'Alpha', b: 'Beta' }));
		const c2 = w.src.commit('two');
		stubs.st.gMode = 'block429';
		const dead = () => new FakeClient('dead', () => new LlmError('x', 'unavailable'));
		const st = await forward(w, makeService(stubs, { ai: [dead()], budgetMs: 300 }), c1, c2);
		assert.ok(st.pending >= 2);
		assert.equal(readJson(w.dstFile('es', 'c.json')).b, 'Beta', 'English placeholder written');
		assert.ok((await w.pending.all()).every((e) => e.kind === 'english'));
		stubs.st.gMode = 'ok';
		await retryPending(w.pending, makeService(stubs, { ai: [dead()] }), log);
		assert.match(readJson(w.dstFile('es', 'c.json')).b, /^g\|es\|/);
		assert.ok((await w.pending.all()).every((e) => e.kind === 'lowconf'));
		await retryPending(w.pending, makeService(stubs, { ai: [aiClient()] }), log);
		assert.equal(readJson(w.dstFile('es', 'c.json')).b, 'ai(Beta)');
		assert.equal(await w.pending.count(), 0);
	});

	// ---------------------------------------------------------------- DestinationRepo-first flow

	await scenario('destination-first: a new English key is translated into every other locale; extra keys and en are untouched', async () => {
		stubs.reset();
		const w = world();
		seedDestination(w);
		W(w.dstFile('en', 'common.json'), json({ a: 'Alpha', b: 'Beta', c: 'Gamma' }));
		const ai = aiClient();
		const res = await reverse(w, makeService(stubs, { ai: [ai] }));
		for (const loc of ['es', 'fr']) {
			assert.equal(readJson(w.dstFile(loc, 'common.json')).c, 'ai(Gamma)', loc);
		}
		assert.equal(readJson(w.dstFile('es', 'common.json')).extra, 'Solo es', 'key that only exists in es is preserved');
		assert.equal(readJson(w.dstFile('es', 'common.json')).a, 'es-Alpha');
		assert.deepEqual(readJson(w.dstFile('en', 'common.json')), { a: 'Alpha', b: 'Beta', c: 'Gamma' });
		assert.equal(res.stats.files, 2);
		assert.equal(res.stats.pending, 0);
		const calls = ai.prompts.length;
		const again = await reverse(w, makeService(stubs, { ai: [ai] }));
		assert.equal(again.stats.files, 0);
		assert.equal(ai.prompts.length, calls, 'second run does nothing');
	});

	await scenario('destination-first: an edited English string (uncommitted) is retranslated everywhere', async () => {
		stubs.reset();
		const w = world();
		seedDestination(w);
		W(w.dstFile('en', 'common.json'), json({ a: 'Alpha, edited', b: 'Beta' }));
		await reverse(w, makeService(stubs, { ai: [aiClient()] }));
		for (const loc of ['es', 'fr']) {
			const j = readJson(w.dstFile(loc, 'common.json'));
			assert.equal(j.a, 'ai(Alpha, edited)', loc);
			assert.equal(j.b, `${loc}-Beta`, 'unedited key left alone');
		}
	});

	await scenario('destination-first: an English key removed (uncommitted) is removed from the other locales only where it exists', async () => {
		stubs.reset();
		const w = world();
		seedDestination(w);
		W(w.dstFile('en', 'common.json'), json({ a: 'Alpha' }));
		await reverse(w, makeService(stubs, { ai: [aiClient()] }));
		assert.deepEqual(readJson(w.dstFile('fr', 'common.json')), { a: 'fr-Alpha' });
		assert.deepEqual(readJson(w.dstFile('es', 'common.json')), { a: 'es-Alpha', extra: 'Solo es' });
	});

	await scenario('destination-first: a key missing in just one locale is translated for that locale only', async () => {
		stubs.reset();
		const w = world();
		seedDestination(w);
		W(w.dstFile('fr', 'common.json'), json({ a: 'fr-Alpha' }));
		const ai = aiClient();
		await reverse(w, makeService(stubs, { ai: [ai] }));
		assert.equal(readJson(w.dstFile('fr', 'common.json')).b, 'ai(Beta)');
		assert.equal(ai.prompts.length, 1);
		assert.match(ai.prompts[0], /locale code "fr"/);
	});

	await scenario('destination-first: a brand-new English file (also in a sub-folder) is created in every locale', async () => {
		stubs.reset();
		const w = world();
		seedDestination(w);
		W(w.dstFile('en', 'admin/menu.json'), json({ title: 'Admin', nested: { x: 'Settings' } }));
		await reverse(w, makeService(stubs, { ai: [aiClient()] }));
		for (const loc of ['es', 'fr']) {
			assert.deepEqual(readJson(w.dstFile(loc, 'admin/menu.json')), { title: 'ai(Admin)', nested: { x: 'ai(Settings)' } }, loc);
		}
	});

	await scenario('destination-first: an edit that was already committed is still found through the snapshot', async () => {
		stubs.reset();
		const w = world();
		seedDestination(w);
		await reverse(w, makeService(stubs, { ai: [aiClient()] })); // first run: everything is already in sync, snapshot recorded
		W(w.dstFile('en', 'common.json'), json({ a: 'Alpha 2', b: 'Beta' }));
		w.dst.commit('edit en and commit it');
		await reverse(w, makeService(stubs, { ai: [aiClient()] }));
		assert.equal(readJson(w.dstFile('es', 'common.json')).a, 'ai(Alpha 2)');
	});

	await scenario('destination-first: with "sync to fallback" ON the English change is also written into the SourceRepo folder; OFF leaves it alone', async () => {
		stubs.reset();
		const off = world();
		seedDestination(off);
		W(path.join(off.srcDir, 'common.json'), json({ a: 'Alpha', b: 'Beta' }));
		off.src.commit('s');
		W(off.dstFile('en', 'common.json'), json({ a: 'Alpha', b: 'Beta', c: 'Gamma' }));
		await reverse(off, makeService(stubs, { ai: [aiClient()] }), false);
		assert.deepEqual(readJson(path.join(off.srcDir, 'common.json')), { a: 'Alpha', b: 'Beta' }, 'fallback untouched');

		const on = world();
		seedDestination(on);
		W(path.join(on.srcDir, 'common.json'), crlf(json({ a: 'Alpha', b: 'Beta' })));
		on.src.commit('s');
		W(on.dstFile('en', 'common.json'), json({ a: 'Alpha', b: 'Beta', c: 'Gamma' }));
		const res = await reverse(on, makeService(stubs, { ai: [aiClient()] }), true);
		assert.deepEqual(readJson(path.join(on.srcDir, 'common.json')), { a: 'Alpha', b: 'Beta', c: 'Gamma' }, 'English copied as it is, not translated');
		assert.equal(res.stats.files, 3, 'es, fr and the fallback file');
		assert.ok(/[^\r]\n/.test(R(path.join(on.srcDir, 'common.json'))) === false, 'fallback file keeps its CRLF');
	});

	await scenario('destination-first with fallback: a missing fallback file is created; fallback keys that are not part of the change are not overwritten', async () => {
		stubs.reset();
		const w = world();
		seedDestination(w);
		W(path.join(w.srcDir, 'common.json'), json({ a: 'Alpha (different wording in the fallback)', b: 'Beta' }));
		w.src.commit('s');
		W(w.dstFile('en', 'common.json'), json({ a: 'Alpha', b: 'Beta', c: 'Gamma' }));
		W(w.dstFile('en', 'new.json'), json({ k: 'Key' }));
		await reverse(w, makeService(stubs, { ai: [aiClient()] }), true);
		const fb = readJson(path.join(w.srcDir, 'common.json'));
		assert.equal(fb.a, 'Alpha (different wording in the fallback)', 'unrelated existing value kept');
		assert.equal(fb.c, 'Gamma');
		assert.deepEqual(readJson(path.join(w.srcDir, 'new.json')), { k: 'Key' });
	});

	await scenario('no double work: a key already translated by the destination-first sync is not translated again when the same text arrives in a SourceRepo commit', async () => {
		stubs.reset();
		const w = world();
		seedDestination(w);
		W(path.join(w.srcDir, 'common.json'), json({ a: 'Alpha', b: 'Beta' }));
		const c1 = w.src.commit('s1');
		W(w.dstFile('en', 'common.json'), json({ a: 'Alpha', b: 'Beta', c: 'Gamma' }));
		const ai = aiClient();
		await reverse(w, makeService(stubs, { ai: [ai] }), true);
		const calls = ai.prompts.length;
		// the developer now commits the English change in the SourceRepo
		const c2 = w.src.commit('commit the fallback change the sync wrote');
		const st = await forward(w, makeService(stubs, { ai: [ai] }), c1, c2);
		assert.equal(ai.prompts.length, calls, 'the AI was not asked again');
		assert.ok(st.skipped >= 2);
		assert.equal(readJson(w.dstFile('es', 'common.json')).c, 'ai(Gamma)');
	});

	await scenario('destination-first: pending/machine results are tracked the same way (AI down)', async () => {
		stubs.reset();
		const w = world();
		seedDestination(w);
		W(w.dstFile('en', 'common.json'), json({ a: 'Alpha', b: 'Beta', c: 'Gamma' }));
		const dead = new FakeClient('dead', () => new LlmError('x', 'unavailable'));
		const res = await reverse(w, makeService(stubs, { ai: [dead] }));
		assert.equal(res.stats.machine, 2);
		assert.equal(await w.pending.count(), 2);
		assert.match(readJson(w.dstFile('es', 'common.json')).c, /^g\|es\|/);
	});

	await scenario('destination-only user: no copy destination at all -> the sync still works and nothing is written outside the destination', async () => {
		stubs.reset();
		const w = world();
		seedDestination(w);
		W(w.dstFile('en', 'common.json'), json({ a: 'Alpha', b: 'Beta', c: 'Gamma' }));
		await reverse(w, makeService(stubs, { ai: [aiClient()] }), false);
		assert.equal(readJson(w.dstFile('es', 'common.json')).c, 'ai(Gamma)');
		assert.ok(!fs.existsSync(path.join(process.cwd(), 'common.json')), 'nothing was written into the current folder');
	});

	// ---------------------------------------------------------------- Sync Locales: only what changed since the last commit

	await scenario('changes only: the edited and the new key are synced, an unrelated key that is missing elsewhere is left alone', async () => {
		stubs.reset();
		const w = world();
		seedDestination(w); // en: a, b   es: a, b, extra   fr: a, b   (committed)
		// fr is missing "old" for a long time: that is NOT part of this change
		W(w.dstFile('en', 'common.json'), json({ a: 'Alpha', b: 'Beta', old: 'Old key' }));
		W(w.dstFile('es', 'common.json'), json({ a: 'es-Alpha', b: 'es-Beta', old: 'es-Old', extra: 'Solo es' }));
		w.dst.commit('old key exists in en and es, but not in fr');
		// the actual change: one edit and one new key, not committed
		W(w.dstFile('en', 'common.json'), json({ a: 'Alpha, edited', b: 'Beta', old: 'Old key', fresh: 'Fresh key' }));
		const ai = aiClient();
		const res = await reverse(w, makeService(stubs, { ai: [ai] }), false, 'changes');
		const es = readJson(w.dstFile('es', 'common.json'));
		const fr = readJson(w.dstFile('fr', 'common.json'));
		assert.equal(es.a, 'ai(Alpha, edited)');
		assert.equal(es.fresh, 'ai(Fresh key)');
		assert.equal(fr.a, 'ai(Alpha, edited)');
		assert.equal(fr.fresh, 'ai(Fresh key)');
		assert.equal(fr.old, undefined, 'the key that was already missing in fr is not part of this sync');
		assert.equal(es.old, 'es-Old', 'untouched');
		assert.equal(es.extra, 'Solo es');
		assert.equal(res.stats.issues.length, 0);
		assert.equal(res.changedFiles, 1);
		assert.ok(ai.prompts.flatMap(itemsIn).every((i) => i.text !== 'Old key'), 'the unrelated key was never one of the strings to translate (it may appear as a reference example)');
	});

	await scenario('changes only: a staged change counts, and so does a new untracked file (all of its keys)', async () => {
		stubs.reset();
		const w = world();
		seedDestination(w);
		W(w.dstFile('en', 'common.json'), json({ a: 'Alpha', b: 'Beta', staged: 'Staged key' }));
		sh('git add -A', w.dst.dir); // staged, not committed
		W(w.dstFile('en', 'brand-new.json'), json({ x: 'X', y: 'Y' })); // untracked
		await reverse(w, makeService(stubs, { ai: [aiClient()] }), false, 'changes');
		assert.equal(readJson(w.dstFile('es', 'common.json')).staged, 'ai(Staged key)');
		assert.deepEqual(readJson(w.dstFile('es', 'brand-new.json')), { x: 'ai(X)', y: 'ai(Y)' });
		assert.deepEqual(readJson(w.dstFile('fr', 'brand-new.json')), { x: 'ai(X)', y: 'ai(Y)' });
	});

	await scenario('changes only: nothing changed since the last commit means nothing is written and nothing is asked of the AI', async () => {
		stubs.reset();
		const w = world();
		seedDestination(w);
		W(w.dstFile('fr', 'common.json'), json({ a: 'fr-Alpha' })); // fr lacks "b", but en has not changed
		w.dst.commit('fr is behind');
		const ai = aiClient();
		const before = R(w.dstFile('fr', 'common.json'));
		const res = await reverse(w, makeService(stubs, { ai: [ai] }), false, 'changes');
		assert.equal(res.changedFiles, 0);
		assert.equal(res.stats.files, 0);
		assert.equal(ai.prompts.length, 0);
		assert.equal(R(w.dstFile('fr', 'common.json')), before);
		// the whole-file mode is still there for catching up
		await reverse(w, makeService(stubs, { ai: [aiClient()] }), false, 'all');
		assert.equal(readJson(w.dstFile('fr', 'common.json')).b, 'ai(Beta)');
	});

	await scenario('changes only: a removed key is removed from the translations, and a key that was never there is not an error', async () => {
		stubs.reset();
		const w = world();
		seedDestination(w);
		W(w.dstFile('en', 'common.json'), json({ a: 'Alpha' })); // b removed
		const res = await reverse(w, makeService(stubs, { ai: [aiClient()] }), false, 'changes');
		assert.equal(readJson(w.dstFile('es', 'common.json')).b, undefined);
		assert.equal(readJson(w.dstFile('fr', 'common.json')).b, undefined);
		assert.equal(readJson(w.dstFile('es', 'common.json')).extra, 'Solo es', 'keys only es has stay');
		assert.equal(res.stats.issues.length, 0);
	});

	await scenario('changes only: a language file that does not exist yet is created with just the changed keys, not the whole source file', async () => {
		stubs.reset();
		const w = world();
		seedDestination(w);
		fs.rmSync(w.dstFile('fr', 'common.json'));
		w.dst.commit('fr/common.json is gone');
		W(w.dstFile('en', 'common.json'), json({ a: 'Alpha', b: 'Beta', c: 'Gamma' })); // only "c" is new
		await reverse(w, makeService(stubs, { ai: [aiClient()] }), false, 'changes');
		assert.deepEqual(readJson(w.dstFile('fr', 'common.json')), { c: 'ai(Gamma)' });
		assert.equal(readJson(w.dstFile('es', 'common.json')).c, 'ai(Gamma)');
	});

	await scenario('changes only: the baseline moves only for the keys that were handled, so a later whole-file sync still finds the rest', async () => {
		stubs.reset();
		const w = world();
		seedDestination(w);
		W(w.dstFile('en', 'common.json'), json({ a: 'Alpha', b: 'Beta', c: 'Gamma' }));
		w.dst.commit('c added but never synced');
		W(w.dstFile('en', 'common.json'), json({ a: 'Alpha', b: 'Beta, edited', c: 'Gamma' }));
		await reverse(w, makeService(stubs, { ai: [aiClient()] }), false, 'changes'); // only "b" changed
		assert.equal(readJson(w.dstFile('es', 'common.json')).b, 'ai(Beta, edited)');
		assert.equal(readJson(w.dstFile('es', 'common.json')).c, undefined, 'c was committed earlier and is not part of this change');
		await reverse(w, makeService(stubs, { ai: [aiClient()] }), false, 'all');
		assert.equal(readJson(w.dstFile('es', 'common.json')).c, 'ai(Gamma)', 'Sync All Missing catches up');
	});

	await scenario('changes only: a source that is not in a git repository falls back to comparing whole files (there is no last commit)', async () => {
		stubs.reset();
		const w = world();
		seedDestination(w);
		const plain = path.join(w.root, 'plain-source');
		W(path.join(plain, 'common.json'), json({ a: 'Alpha', z: 'Zed' }));
		const cfg = { ...w.cfg, sourceDir: plain, destinations: [T(w.dstDir)] };
		const res = await syncFromSource(cfg, { makeService: async () => makeService(stubs, { ai: [aiClient()] }), pending: w.pending, snapshots: w.snapshots }, 'git', log, 'changes');
		assert.equal(res.fellBack, true);
		assert.equal(readJson(w.dstFile('es', 'common.json')).z, 'ai(Zed)');
	});

	await scenario('changes only, copy destination: the copy gets just the changed keys as they are', async () => {
		stubs.reset();
		const w = world();
		seedDestination(w);
		W(path.join(w.srcDir, 'common.json'), json({ a: 'Alpha (older wording)', b: 'Beta', keep: 'only in the copy' }));
		w.src.commit('copy folder content');
		W(w.dstFile('en', 'common.json'), json({ a: 'Alpha', b: 'Beta', c: 'Gamma' })); // only "c" is new
		await reverse(w, makeService(stubs, { ai: [aiClient()] }), true, 'changes');
		const copy = readJson(path.join(w.srcDir, 'common.json'));
		assert.equal(copy.c, 'Gamma', 'copied, not translated');
		assert.equal(copy.a, 'Alpha (older wording)', 'not part of the change, not overwritten');
		assert.equal(copy.keep, 'only in the copy');
	});

	// ---------------------------------------------------------------- which engine made the strings

	await scenario('engines: every translated string is attributed to the model that made it, and machine translation is named as such', async () => {
		stubs.reset();
		const w = world();
		seedDestination(w);
		W(w.dstFile('en', 'common.json'), json({ a: 'Alpha', b: 'Beta', c: 'Gamma', d: 'Delta' })); // c and d are new: 2 strings x 2 languages
		const ai = aiClient();
		const res = await reverse(w, makeService(stubs, { ai: [ai] }), false, 'changes');
		assert.deepEqual(res.stats.engines, { [ai.label]: 4 });

		const w2 = world();
		seedDestination(w2);
		W(w2.dstFile('en', 'common.json'), json({ a: 'Alpha', b: 'Beta', c: 'Gamma' }));
		const dead = new FakeClient('dead', () => new LlmError('x', 'unavailable'));
		const res2 = await reverse(w2, makeService(stubs, { ai: [dead] }), false, 'changes');
		assert.deepEqual(res2.stats.engines, { 'machine translation': 2 }, 'the fallback is named, not passed off as the AI');
	});

	// ---------------------------------------------------------------- Stop

	/** A model that answers normally until its Nth request, where the user presses Stop. */
	const stopsAt = (n: number, ctl: AbortController) => {
		const inner = aiClient();
		let calls = 0;
		const client: LlmClient = {
			label: 'stopper',
			async complete(prompt) {
				calls++;
				if (calls >= n) {
					ctl.abort();
					throw new Cancelled();
				}
				return inner.complete(prompt);
			},
		};
		return client;
	};

	await scenario('stop: a Sync Locales stopped halfway keeps the files already written, leaves the rest untouched, reports it, and does not move the baseline', async () => {
		stubs.reset();
		const w = world();
		seedDestination(w);
		W(w.dstFile('en', 'a.json'), json({ k: 'First file' }));
		W(w.dstFile('en', 'b.json'), json({ k: 'Second file' }));
		const ctl = new AbortController();
		const svc = makeService(stubs, { ai: [stopsAt(3, ctl)], signal: ctl.signal }); // a -> es, a -> fr, then Stop while b -> es
		const res = await syncFromSource(reverseCfg(w), { makeService: async () => svc, pending: w.pending, snapshots: w.snapshots, signal: ctl.signal }, 'git', log, 'all');
		assert.equal(res.cancelled, true);
		assert.deepEqual(readJson(w.dstFile('es', 'a.json')), { k: 'ai(First file)' });
		assert.deepEqual(readJson(w.dstFile('fr', 'a.json')), { k: 'ai(First file)' });
		assert.ok(!fs.existsSync(w.dstFile('es', 'b.json')), 'the file that was being translated when Stop was pressed was not written');
		assert.ok(!fs.existsSync(w.dstFile('fr', 'b.json')));
		assert.deepEqual(await w.snapshots.scope(w.dstDir).keysOf('b.json'), [], 'no baseline claims keys that were never synced');
		assert.equal(await w.pending.count(), 0, 'no English placeholders were queued for the stopped strings');
	});

	await scenario('stop: pressing Stop before anything started does nothing and still returns normally', async () => {
		stubs.reset();
		const w = world();
		seedDestination(w);
		W(w.dstFile('en', 'common.json'), json({ a: 'Alpha', b: 'Beta', c: 'Gamma' }));
		const ctl = new AbortController();
		ctl.abort();
		const svc = makeService(stubs, { ai: [aiClient()], signal: ctl.signal });
		const res = await syncFromSource(reverseCfg(w), { makeService: async () => svc, pending: w.pending, snapshots: w.snapshots, signal: ctl.signal }, 'git', log, 'changes');
		assert.equal(res.cancelled, true);
		assert.equal(res.stats.files, 0);
		assert.equal(readJson(w.dstFile('es', 'common.json')).c, undefined);
	});

	await scenario('stop: a commit sync stopped halfway reports it and keeps what was written', async () => {
		stubs.reset();
		const w = world();
		W(path.join(w.srcDir, 'x.json'), json({ x: 'X' }));
		const c1 = w.src.commit('one');
		W(path.join(w.srcDir, 'a.json'), json({ k: 'First file' }));
		W(path.join(w.srcDir, 'b.json'), json({ k: 'Second file' }));
		const c2 = w.src.commit('two');
		const ctl = new AbortController();
		const svc = makeService(stubs, { ai: [stopsAt(3, ctl)], signal: ctl.signal });
		const st = await syncCommit(w.cfg, { makeService: async () => svc, pending: w.pending, snapshots: w.snapshots, signal: ctl.signal }, 'git', w.src.dir, c1, c2, log);
		assert.equal(st.cancelled, true);
		assert.deepEqual(readJson(w.dstFile('es', 'a.json')), { k: 'ai(First file)' });
		assert.ok(!fs.existsSync(w.dstFile('es', 'b.json')));
	});

	await scenario('stop: retrying the waiting strings keeps what it finished and leaves the rest queued', async () => {
		stubs.reset();
		const w = world();
		W(w.dstFile('es', 'a.json'), json({ k: 'First' }));
		W(w.dstFile('es', 'b.json'), json({ k: 'Second' }));
		await w.pending.add([
			{ file: w.dstFile('es', 'a.json'), path: ['k'], text: 'First', locale: 'es', since: 1, kind: 'english', written: 'First' },
			{ file: w.dstFile('es', 'b.json'), path: ['k'], text: 'Second', locale: 'es', since: 1, kind: 'english', written: 'Second' },
		]);
		const ctl = new AbortController();
		const svc = makeService(stubs, { ai: [stopsAt(2, ctl)], signal: ctl.signal }); // a is finished, Stop while b is being translated
		const res = await retryPending(w.pending, svc, log);
		assert.equal(res.fixed, 1);
		assert.equal(res.remaining, 1);
		assert.equal(readJson(w.dstFile('es', 'a.json')).k, 'ai(First)');
		assert.equal(readJson(w.dstFile('es', 'b.json')).k, 'Second', 'untouched');
		assert.equal(await w.pending.count(), 1);
	});

	// ---------------------------------------------------------------- broken files and structure clashes

	await scenario('a locale file that is not valid JSON is left untouched and reported; the other locales still sync; fixing it later fills it', async () => {
		stubs.reset();
		const w = world();
		seedDestination(w);
		const broken = '{ "a": "es-Alpha", "b": ';
		W(w.dstFile('es', 'common.json'), broken);
		W(w.dstFile('en', 'common.json'), json({ a: 'Alpha', b: 'Beta', c: 'Gamma' }));
		const res = await reverse(w, makeService(stubs, { ai: [aiClient()] }));
		assert.equal(R(w.dstFile('es', 'common.json')), broken, 'the broken file was not modified');
		assert.equal(readJson(w.dstFile('fr', 'common.json')).c, 'ai(Gamma)', 'fr was synced anyway');
		assert.equal(res.stats.issues.length, 1);
		assert.equal(res.stats.issues[0].kind, 'invalid-json');
		assert.equal(res.stats.issues[0].locale, 'es');
		assert.equal(res.stats.issues[0].rel, 'common.json');
		assert.ok((res.stats.issues[0].line ?? 0) >= 1);
		// once someone fixes the file the missing key arrives (the baseline was not advanced past it)
		W(w.dstFile('es', 'common.json'), json({ a: 'es-Alpha', b: 'es-Beta' }));
		const again = await reverse(w, makeService(stubs, { ai: [aiClient()] }));
		assert.equal(again.stats.issues.length, 0);
		assert.equal(readJson(w.dstFile('es', 'common.json')).c, 'ai(Gamma)');
	});

	await scenario('a base-language file that is not valid JSON is reported and skipped', async () => {
		stubs.reset();
		const w = world();
		seedDestination(w);
		W(w.dstFile('en', 'bad.json'), '{ "x": "one" "y": "two" }');
		const scan = await scanSource(reverseCfg(w), { snapshots: w.snapshots }, 'git', log);
		assert.equal(scan.issues.length, 1);
		assert.equal(scan.issues[0].locale, 'en');
		assert.equal(scan.issues[0].rel, 'bad.json');
	});

	await scenario('a key whose place clashes with the base language is skipped and reported; the rest of the file is written', async () => {
		stubs.reset();
		const w = world();
		W(w.dstFile('en', 'common.json'), json({ a: 'Alpha', group: { x: 'X', y: 'Y' }, text: 'Text' }));
		// es: "group" is a plain text here, and "text" is a group of keys
		W(w.dstFile('es', 'common.json'), json({ a: 'es-Alpha', group: 'oops', text: { t: 'T' } }));
		W(w.dstFile('fr', 'common.json'), json({}));
		w.dst.commit('seed');
		const res = await reverse(w, makeService(stubs, { ai: [aiClient()] }));
		const es = readJson(w.dstFile('es', 'common.json'));
		assert.equal(es.group, 'oops', 'not overwritten');
		assert.deepEqual(es.text, { t: 'T' }, 'not overwritten');
		assert.equal(es.a, 'es-Alpha');
		assert.deepEqual(res.stats.issues.filter((i) => i.locale === 'es').map((i) => [i.kind, i.key]).sort(), [['structure', 'group.x'], ['structure', 'group.y'], ['structure', 'text']]);
		assert.equal(readJson(w.dstFile('fr', 'common.json')).group.x, 'ai(X)', 'fr is fine and fully filled');
	});

	await scenario('an empty locale file counts as an empty object and is filled', async () => {
		stubs.reset();
		const w = world();
		W(w.dstFile('en', 'common.json'), json({ a: 'Alpha' }));
		W(w.dstFile('es', 'common.json'), '');
		W(w.dstFile('fr', 'common.json'), json({ a: 'fr-Alpha' }));
		w.dst.commit('seed');
		const res = await reverse(w, makeService(stubs, { ai: [aiClient()] }));
		assert.equal(res.stats.issues.length, 0);
		assert.equal(readJson(w.dstFile('es', 'common.json')).a, 'ai(Alpha)');
	});

	await scenario('forward flow: a locale file with broken JSON is skipped and reported, the others are written', async () => {
		stubs.reset();
		const w = world();
		W(path.join(w.srcDir, 'common.json'), json({ a: 'Alpha' }));
		const c1 = w.src.commit('one');
		for (const l of LOCALES) {
			W(w.dstFile(l, 'common.json'), json({ a: l === 'en' ? 'Alpha' : `${l}-Alpha` }));
		}
		W(w.dstFile('es', 'common.json'), '{ nope');
		W(path.join(w.srcDir, 'common.json'), json({ a: 'Alpha', b: 'Beta' }));
		const c2 = w.src.commit('two');
		const st = await forward(w, makeService(stubs, { ai: [aiClient()] }), c1, c2);
		assert.equal(R(w.dstFile('es', 'common.json')), '{ nope');
		assert.equal(readJson(w.dstFile('fr', 'common.json')).b, 'ai(Beta)');
		assert.equal(st.issues.length, 1);
	});

	await scenario('scan: lists missing and out-of-date keys per locale and file, writes nothing', async () => {
		stubs.reset();
		const w = world();
		seedDestination(w);
		await reverse(w, makeService(stubs, { ai: [aiClient()] })); // records the baseline
		W(w.dstFile('en', 'common.json'), json({ a: 'Alpha, edited', b: 'Beta', c: 'Gamma' }));
		W(w.dstFile('en', 'extra.json'), json({ only: 'New file' }));
		const before = ['es', 'fr'].map((l) => R(w.dstFile(l, 'common.json')));
		const scan = await scanSource(reverseCfg(w), { snapshots: w.snapshots }, 'git', log);
		const key = (e: { locale: string; rel: string; keys: string[] }) => `${e.locale}:${e.rel}:${e.keys.join(',')}`;
		assert.deepEqual(scan.missing.map(key).sort(), ['es:common.json:c', 'es:extra.json:only', 'fr:common.json:c', 'fr:extra.json:only']);
		assert.deepEqual(scan.outdated.map(key).sort(), ['es:common.json:a', 'fr:common.json:a']);
		assert.deepEqual(scan.issues, []);
		assert.deepEqual(['es', 'fr'].map((l) => R(w.dstFile(l, 'common.json'))), before, 'nothing was written');
		assert.ok(!fs.existsSync(w.dstFile('es', 'extra.json')), 'no file was created');
	});

	await scenario('destinations are independent: with the locales left out only the fallback copy is made, and including them later still translates the edit', async () => {
		stubs.reset();
		const w = world();
		seedDestination(w);
		await reverse(w, makeService(stubs, { ai: [aiClient()] })); // baseline
		W(w.dstFile('en', 'common.json'), json({ a: 'Alpha, edited', b: 'Beta', c: 'Gamma' }));
		const ai = aiClient();
		const res = await syncFromSource(reverseCfg(w, true, false), { makeService: async () => makeService(stubs, { ai: [ai] }), pending: w.pending, snapshots: w.snapshots }, 'git', log, 'all');
		assert.equal(ai.prompts.length, 0, 'nothing was translated');
		assert.deepEqual(readJson(path.join(w.srcDir, 'common.json')), { a: 'Alpha, edited', b: 'Beta', c: 'Gamma' }, 'the fallback copy was written');
		assert.equal(readJson(w.dstFile('es', 'common.json')).c, undefined, 'es untouched');
		assert.equal(res.stats.files, 1, 'only the fallback file');
		// now include the locales too: the edit and the new key are still found
		await reverse(w, makeService(stubs, { ai: [aiClient()] }));
		assert.equal(readJson(w.dstFile('es', 'common.json')).c, 'ai(Gamma)');
		assert.equal(readJson(w.dstFile('es', 'common.json')).a, 'ai(Alpha, edited)');
	});

	await scenario('destinations: only the translations are written when the fallback is left out', async () => {
		stubs.reset();
		const w = world();
		seedDestination(w);
		W(w.dstFile('en', 'common.json'), json({ a: 'Alpha', b: 'Beta', c: 'Gamma' }));
		await reverse(w, makeService(stubs, { ai: [aiClient()] }), false);
		assert.equal(readJson(w.dstFile('fr', 'common.json')).c, 'ai(Gamma)');
		assert.ok(!fs.existsSync(path.join(w.srcDir, 'common.json')), 'the fallback folder was not touched');
	});

	await scenario('each destination keeps its own baseline: an edit synced to the locales only still reaches the fallback copy when it is included later', async () => {
		stubs.reset();
		const w = world();
		seedDestination(w);
		W(path.join(w.srcDir, 'common.json'), json({ a: 'Alpha', b: 'Beta' }));
		w.src.commit('fallback');
		await reverse(w, makeService(stubs, { ai: [aiClient()] }), true); // baseline for both destinations
		W(w.dstFile('en', 'common.json'), json({ a: 'Alpha, edited', b: 'Beta' }));
		await reverse(w, makeService(stubs, { ai: [aiClient()] }), false); // batch 1: locales only
		assert.equal(readJson(w.dstFile('es', 'common.json')).a, 'ai(Alpha, edited)');
		assert.equal(readJson(path.join(w.srcDir, 'common.json')).a, 'Alpha', 'the fallback was left out of batch 1');
		const ai = aiClient();
		await syncFromSource(reverseCfg(w, true, false), { makeService: async () => makeService(stubs, { ai: [ai] }), pending: w.pending, snapshots: w.snapshots }, 'git', log, 'all'); // batch 2: fallback only
		assert.equal(readJson(path.join(w.srcDir, 'common.json')).a, 'Alpha, edited', 'batch 2 brought the fallback up to date');
		assert.equal(ai.prompts.length, 0);
	});

	await scenario('forward flow writes a commit to every destination: translated into the locales folder, copied as it is into the copy folder', async () => {
		stubs.reset();
		const w = world();
		const other = path.join(w.root, 'OtherRepo', 'locales', 'en');
		W(path.join(w.srcDir, 'common.json'), json({ a: 'Alpha' }));
		const c1 = w.src.commit('one');
		for (const l of LOCALES) {
			W(w.dstFile(l, 'common.json'), json({ a: l === 'en' ? 'Alpha' : `${l}-Alpha` }));
		}
		W(path.join(other, 'common.json'), json({ a: 'Alpha' }));
		W(path.join(w.srcDir, 'common.json'), json({ a: 'Alpha', b: 'Beta' }));
		const c2 = w.src.commit('two');
		const cfg: SyncConfig = { ...w.cfg, destinations: [T(w.dstDir), C(other)] };
		await syncCommit(cfg, { makeService: async () => makeService(stubs, { ai: [aiClient()] }), pending: w.pending, snapshots: w.snapshots }, 'git', w.src.dir, c1, c2, log);
		assert.equal(readJson(w.dstFile('es', 'common.json')).b, 'ai(Beta)');
		assert.equal(readJson(w.dstFile('en', 'common.json')).b, 'Beta', 'the base language is copied, not translated');
		assert.equal(readJson(path.join(other, 'common.json')).b, 'Beta', 'the copy folder got the base language as it is');
	});

	stubs.close();
	void fs;
	void newStats;
	done();
})();
