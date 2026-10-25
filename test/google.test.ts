import { GoogleBlocked, ProviderHealth, Translator, googleRequestUrl, parseGoogle } from '../src/translator';
import { FAST, Stubs, startStubs } from './fixtures';
import { assert, done, scenario } from './helper';

(async () => {
	const stubs: Stubs = await startStubs();

	const mk = (o: { endpoints?: string[]; provider?: 'auto' | 'backend' | 'google'; budgetMs?: number; timing?: object; health?: ProviderHealth } = {}) =>
		new Translator(
			{
				backendUrl: stubs.backendUrl,
				googleEndpoints: o.endpoints ?? [stubs.googleChromeUrl, stubs.googleUrl],
				backendTimeoutMs: 800,
				provider: o.provider ?? 'google',
				expectedStrings: 1,
				budgetMs: o.budgetMs ?? 20000,
				timing: { ...FAST, ...o.timing },
				log: () => undefined,
			},
			'en',
			o.health ?? new ProviderHealth(),
		);
	const strings = (n: number) => Array.from({ length: n }, (_, i) => `Item number ${i} was saved`);

	await scenario('answer shapes of both Google endpoint styles are understood; junk is rejected', () => {
		assert.equal(parseGoogle(['Guardar cambios']), 'Guardar cambios');
		assert.equal(parseGoogle([['Guardar', 'Save']]), 'Guardar');
		assert.equal(parseGoogle([[['Hola ', 'Hello '], ['mundo', 'world']], null, 'en']), 'Hola mundo');
		assert.equal(parseGoogle(['a\nb\nc']), 'a\nb\nc');
		assert.throws(() => parseGoogle({}), /bad response/);
		assert.throws(() => parseGoogle([]), /bad response/);
		assert.match(googleRequestUrl('https://clients5.google.com/translate_a/t', 'Hi there', 'es', 'en'), /client=dict-chrome-ex.*q=Hi%20there/);
		assert.match(googleRequestUrl('https://translate.googleapis.com/translate_a/single', 'Hi', 'es', 'en'), /client=gtx.*dt=t/);
	});

	await scenario('a whole commit goes out in a few requests: 40 strings -> 2 requests, order and placeholders intact', async () => {
		stubs.reset();
		const t = mk();
		const texts = [...strings(38), 'Hello {{name}}, you have <b>{{n}}</b> items', 'Use %s here'];
		const out = await t.translateMany(texts, 'es');
		assert.equal(stubs.st.g, 2, `requests: ${stubs.st.g}`);
		assert.deepEqual(stubs.st.gLines, [20, 20]);
		assert.ok(out.every((r) => !r.fellBack && r.value.startsWith('g|es|')));
		assert.ok(out[38].value.includes('{{name}}') && out[38].value.includes('<b>') && out[38].value.includes('{{n}}'));
		assert.ok(out[39].value.includes('%s'));
		assert.ok(out[3].value.includes('3'), 'item 3 got its own translation back, not a neighbour\'s');
	});

	await scenario('if Google merges or drops lines the batch is not trusted: every string is translated on its own', async () => {
		stubs.reset();
		stubs.st.gMode = 'merge';
		const out = await mk().translateMany(strings(6), 'es');
		assert.ok(out.every((r) => !r.fellBack && r.value.startsWith('g|es|')));
		assert.ok(stubs.st.g >= 7, 'one batch request, then one per string: ' + stubs.st.g);
	});

	await scenario('multi-line, empty and already-translated strings are handled around the batch', async () => {
		stubs.reset();
		const t = mk();
		await t.translateMany(['Save'], 'es');
		stubs.st.g = 0;
		const out = await t.translateMany(['Save', '', 'First line\nSecond line', 'Cancel'], 'es');
		assert.equal(out[1].value, '');
		assert.equal(out[2].value.split('\n').length, 2, 'line break kept');
		assert.ok(out[0].value.startsWith('g|es|'));
		assert.equal(stubs.st.g, 3, '"Save" came from the cache; Cancel batch (1) + two lines of the multi-line string');
	});

	await scenario('a blocked endpoint is skipped: the next one answers, and the blocked one is not asked again', async () => {
		stubs.reset();
		stubs.st.gBlockedPaths.add('/translate_a/t'); // the first (Chrome-style) endpoint is blocked
		const t = mk();
		const first = await t.translateMany(strings(3), 'es');
		assert.ok(first.every((r) => r.value.startsWith('g|es|')));
		const calls = stubs.st.gPaths['/translate_a/t'];
		await t.translateMany(['Another string'], 'es');
		await t.translateMany(['And one more string'], 'es');
		assert.equal(stubs.st.gPaths['/translate_a/t'], calls, 'not retried while it is known to be blocked');
		assert.ok(stubs.st.gPaths['/translate_a/single'] >= 3);
	});

	await scenario('every endpoint blocked: the Space (if awake) answers instead, nothing is lost', async () => {
		stubs.reset();
		stubs.st.gMode = 'block429';
		const t = mk({ provider: 'auto' });
		const out = await t.translateMany(strings(3), 'es');
		assert.ok(out.every((r) => !r.fellBack && /^b\|es\|/.test(r.value)), JSON.stringify(out));
	});

	await scenario('all blocked and the Space down: strings come back as fell-back (the caller queues them), within the time budget', async () => {
		stubs.reset();
		stubs.st.gMode = 'block429';
		stubs.st.bMode = 'asleep503';
		const t0 = Date.now();
		const out = await mk({ provider: 'auto', budgetMs: 700 }).translateMany(strings(4), 'es');
		assert.ok(out.every((r) => r.fellBack));
		assert.ok(Date.now() - t0 < 4000);
	});

	await scenario('requests are paced: a minimum gap between Google calls', async () => {
		stubs.reset();
		const t = mk({ timing: { googleMinIntervalMs: 150 } });
		const t0 = Date.now();
		for (let i = 0; i < 4; i++) {
			await t.translate(`Distinct sentence ${i}`, 'es');
		}
		assert.ok(Date.now() - t0 >= 3 * 150 - 20, 'elapsed ' + (Date.now() - t0));
	});

	await scenario('a block cooldown grows each time Google blocks again, and clears after a success', async () => {
		stubs.reset();
		const h = new ProviderHealth();
		stubs.st.gMode = 'block429';
		const t = mk({ health: h, budgetMs: 1500 });
		await t.translateMany(strings(2), 'es');
		assert.ok(h.googleBlocks >= 1);
		assert.ok(h.googleCooldownUntil > Date.now() - 1, 'in cooldown');
		stubs.reset();
		h.googleBlocked.clear();
		h.googleCooldownUntil = 0;
		await mk({ health: h }).translateMany(strings(2), 'es');
		assert.equal(h.googleBlocks, 0);
		assert.ok(new GoogleBlocked('x') instanceof Error);
	});

	stubs.close();
	done();
})();
