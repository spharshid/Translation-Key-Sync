import { flattenStrings, pickReferences } from '../src/ai/refs';
import { buildRetryPrompt, buildReviewPrompt, buildTranslatePrompt, parseJsonReply, splitBatches } from '../src/ai/prompt';
import { parseContext } from '../src/context';
import { assert, done, scenario } from './helper';

const { context } = parseContext({
	appContext: 'A web app for planning and tracking work.',
	style: { default: 'Polite and concise.', locales: { es: 'Use formal usted.' } },
	glossary: [
		{ term: 'Board', aliases: ['Boards'], note: 'a page of cards in columns', translations: { es: 'tablero', ta: 'பலகை' } },
		{ term: 'Unused', translations: { es: 'sin uso' } },
	],
	doNotTranslate: ['Acme'],
});
const base = {
	sourceLocale: 'en',
	locale: 'es',
	file: 'common.json',
	items: [
		{ id: 's0', text: 'Create a new board', keyPath: 'buttons.createBoard' },
		{ id: 's1', text: 'Welcome to Acme', keyPath: 'home.title' },
	],
	refs: [{ key: 'buttons.save', source: 'Save', target: 'Guardar' }],
	context,
};

(async () => {
	await scenario('only Tamil is filled in: the Tamil prompt carries the approved word and the avoid list; Spanish gets only the meaning, nothing of the Tamil', () => {
		const { context: ctx } = parseContext({
			glossary: [{ term: 'Board', aliases: ['Boards'], meaning: 'A page of cards in columns that tracks the progress of work. Not a wooden board.', translations: { ta: 'பலகை' }, avoid: { ta: ['குழு'] } }],
		});
		const items = [{ id: 's0', text: 'Delete all boards', keyPath: 'boards.delete' }];
		const ta = buildTranslatePrompt({ sourceLocale: 'en', locale: 'ta', file: 'f.json', items, refs: [], context: ctx });
		assert.match(ta, /- "Board" => "பலகை"  \(meaning in this product: A page of cards in columns/);
		assert.match(ta, /NEVER use "குழு" for it/);
		for (const loc of ['es', 'fr']) {
			const p = buildTranslatePrompt({ sourceLocale: 'en', locale: loc, file: 'f.json', items, refs: [], context: ctx });
			assert.match(p, /Product terms with no approved (Spanish|French) word/, loc);
			assert.match(p, /- "Board": A page of cards in columns that tracks the progress of work/, loc);
			assert.ok(!p.includes('ஓட்டம்') && !p.includes('பாய்கிறது') && !p.includes('NEVER use'), 'nothing from the Tamil entry leaks into ' + loc);
			assert.ok(!p.includes('Approved glossary (mandatory)'), 'no approved word for ' + loc);
		}
	});

	await scenario('avoid works without a meaning or an approved word', () => {
		const { context: ctx } = parseContext({ glossary: [{ term: 'Board', avoid: { ta: ['குழு'] } }] });
		const p = buildTranslatePrompt({ sourceLocale: 'en', locale: 'ta', file: 'f.json', items: [{ id: 's0', text: 'Open the board', keyPath: 'a.b' }], refs: [], context: ctx });
		assert.match(p, /NEVER use "குழு"/);
		assert.match(p, /Product terms with no approved Tamil word/);
	});

	await scenario('a term with only a meaning is sent as a product term to translate by meaning, not literally; approved terms stay in the mandatory glossary', () => {
		const { context: ctx } = parseContext({
			glossary: [
				{ term: 'Board', aliases: ['Boards'], meaning: 'A page of cards in columns that tracks the progress of work. Not a wooden board.' },
				{ term: 'Rule builder', meaning: 'Where a custom rule is written. Not a construction tool.' },
				{ term: 'Release', meaning: 'A published version of the software.', translations: { ta: 'வெளியீடு' } },
			],
		});
		const p = buildTranslatePrompt({
			sourceLocale: 'en',
			locale: 'ta',
			file: 'boards.json',
			items: [{ id: 's0', text: 'Open the Rule builder for this board', keyPath: 'boards.edit' }, { id: 's1', text: 'Choose a release', keyPath: 'boards.release' }],
			refs: [],
			context: ctx,
		});
		assert.match(p, /Product terms with no approved Tamil word/);
		assert.match(p, /- "Rule builder": Where a custom rule is written\. Not a construction tool\./);
		assert.match(p, /- "Board": A page of cards in columns/);
		assert.match(p, /never literally/);
		assert.match(p, /Approved glossary \(mandatory\)[^]*- "Release" => "வெளியீடு"  \(meaning in this product: A published version of the software\.\)/);
		const none = buildTranslatePrompt({ ...base, locale: 'fr', items: [{ id: 's0', text: 'Nothing to see', keyPath: 'a.b' }], context: ctx });
		assert.ok(!none.includes('Product terms'), 'no terms in the text, no block');
	});

	await scenario('prompt carries context, style, only the glossary terms that occur, KEEP names, key paths and references', () => {
		const p = buildTranslatePrompt(base);
		assert.match(p, /from English into Spanish \(locale code "es"\)/);
		assert.match(p, /Product context: A web app for planning and tracking work\./);
		assert.match(p, /Style for Spanish: Use formal usted\./);
		assert.match(p, /"Board" => "tablero"  \(meaning in this product: a page of cards in columns\)/);
		assert.match(p, /KEEP "Acme"/);
		assert.ok(!p.includes('sin uso'), 'glossary entries not in the batch are left out');
		assert.match(p, /"key":"buttons\.createBoard"/);
		assert.match(p, /"es":"Guardar"/);
		assert.match(p, /inflect, conjugate and position it/);
		assert.match(p, /Copy placeholders EXACTLY/);
		assert.match(p, /for all 2 ids/);
	});

	await scenario('without a context file the prompt still works (no glossary / context sections)', () => {
		const p = buildTranslatePrompt({ ...base, context: { glossary: [], doNotTranslate: [] }, refs: [] });
		assert.ok(!/Approved glossary/.test(p) && !/Product context/.test(p) && !/Reference translations/.test(p));
	});

	await scenario('retry prompt lists only the failing strings with their problems; review prompt carries the drafts', () => {
		const r = buildRetryPrompt(base, [{ id: 's1', previous: 'Bienvenido a Acmé', problems: ['"Acme" must stay as "Acme"'] }]);
		assert.match(r, /"previous":"Bienvenido a Acmé"/);
		assert.ok(!r.includes('Create a new board'));
		assert.match(r, /exactly these 1 ids/);
		const rv = buildReviewPrompt(base, { s0: 'Crear un tablero nuevo', s1: 'Bienvenido a Acme' });
		assert.match(rv, /"draft":"Crear un tablero nuevo"/);
		assert.match(rv, /You are now the reviewer/);
	});

	await scenario('parseJsonReply tolerates fences and prose, rejects junk', () => {
		assert.deepEqual(parseJsonReply('```json\n{"s0":"a","s1":"b"}\n```'), { s0: 'a', s1: 'b' });
		assert.deepEqual(parseJsonReply('Here you go: {"s0":"a"} hope it helps'), { s0: 'a' });
		assert.deepEqual(parseJsonReply('{"s0":"a","n":5}'), { s0: 'a' });
		assert.equal(parseJsonReply('no json'), null);
		assert.equal(parseJsonReply('{broken'), null);
		assert.equal(parseJsonReply('["a"]'), null);
	});

	await scenario('splitBatches respects the character and item limits', () => {
		const items = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, text: 'x'.repeat(100) }));
		const b = splitBatches(items, 500, 100);
		assert.ok(b.length >= 3 && b.every((x) => x.length <= 3));
		assert.equal(b.flat().length, 10);
		assert.equal(splitBatches(items, 100000, 4).length, 3);
		assert.deepEqual(splitBatches([], 100, 10), []);
	});

	await scenario('flattenStrings + pickReferences prefer the same section and shared vocabulary', () => {
		const src = {
			buttons: { save: 'Save', cancel: 'Cancel', createBoard: 'Create a new board' },
			errors: { network: 'Network connection lost', board: { missing: 'The board could not be found' } },
			misc: { about: 'About this product' },
		};
		const tgt = {
			buttons: { save: 'Guardar', cancel: 'Cancelar', createBoard: 'Crear un tablero nuevo' },
			errors: { network: 'Conexión perdida', board: { missing: 'No se encontró el tablero' } },
			misc: { about: 'Acerca de' },
		};
		assert.equal(flattenStrings(src).get('errors.board.missing'), 'The board could not be found');
		const refs = pickReferences(src, tgt, [{ keyPath: 'buttons.deleteBoard', text: 'Delete this board' }], 3);
		const keys = refs.map((r) => r.key);
		assert.equal(keys[0], 'buttons.createBoard', 'sibling button with shared word ranks first: ' + keys);
		assert.ok(keys.includes('errors.board.missing'), 'shared vocabulary ("board") pulls in the error string');
		assert.ok(refs.length <= 3);
		const none = pickReferences(src, tgt, [{ keyPath: 'buttons.save', text: 'Save' }], 5);
		assert.ok(!none.some((r) => r.key === 'buttons.save'), 'never the string being translated');
		assert.deepEqual(pickReferences(null, tgt, [], 5), []);
	});

	done();
})();
