import * as fs from 'fs';
import * as path from 'path';
import { CONTEXT_SCHEMA, CONTEXT_TEMPLATE, parseContext, styleFor, termsIn, usesApproved } from '../src/context';
import { assert, done, scenario } from './helper';

(async () => {
	await scenario('schemas/i18n-context.schema.json is the schema the code ships (regenerate it when the context format changes)', () => {
		const onDisk = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'schemas', 'i18n-context.schema.json'), 'utf8'));
		assert.deepEqual(onDisk, JSON.parse(JSON.stringify(CONTEXT_SCHEMA)));
	});

	await scenario('the shipped template is valid (no problems) and has the expected sections', () => {
		const { context, problems } = parseContext(JSON.parse(JSON.stringify(CONTEXT_TEMPLATE)));
		assert.deepEqual(problems, []);
		assert.ok(context.appContext);
		assert.equal(context.glossary.length, 2);
		assert.equal(context.glossary[1].translations.es, undefined, 'the second example has a meaning only');
		assert.equal(context.doNotTranslate.length, 2);
	});

	await scenario('problems are reported, usable entries survive', () => {
		const { context, problems } = parseContext({
			glossary: [{ term: 'Board', translations: { ta: 'x' } }, { term: 'NoTranslations' }, { translations: { es: 'y' } }, 'junk'],
			doNotTranslate: ['Acme', 5, { term: 'Beta', translations: { ar: 'بيتا' } }],
		});
		assert.equal(context.glossary.length, 1);
		assert.equal(context.doNotTranslate.length, 2);
		assert.equal(problems.length, 4, problems.join(' | '));
		assert.ok(parseContext('nope').problems.length === 1);
	});

	await scenario('a term can have just a meaning: it is kept, "note" still works as the old name, and an entry with neither is reported', () => {
		const { context, problems } = parseContext({
			glossary: [
				{ term: 'Board', aliases: ['Boards'], meaning: 'A page of cards in columns, not a wooden board.' },
				{ term: 'Release', note: 'A published version of the software.' },
				{ term: 'Empty' },
			],
		});
		assert.deepEqual(context.glossary.map((g) => [g.term, g.meaning, Object.keys(g.translations).length]), [
			['Board', 'A page of cards in columns, not a wooden board.', 0],
			['Release', 'A published version of the software.', 0],
		]);
		assert.equal(problems.length, 1);
		assert.match(problems[0], /Empty.*no "meaning", "translations" or "avoid"/);
	});

	await scenario('avoid: a word or a list per language; an entry may have only that', () => {
		const { context, problems } = parseContext({
			glossary: [
				{ term: 'Board', avoid: { ta: ['a', ' b '], es: 'junta', fr: [], de: [''] } },
				{ term: 'Release', meaning: 'A published version of the software.', avoid: 'not-an-object' },
			],
		});
		assert.deepEqual(context.glossary[0].avoid, { ta: ['a', 'b'], es: ['junta'] }, 'empty lists are dropped');
		assert.equal(context.glossary[1].avoid, undefined, 'a malformed avoid is ignored, the entry survives');
		assert.deepEqual(problems, []);
	});

	await scenario('only one language is filled in: that language gets the approved word and the avoid list, every other language gets the meaning alone', () => {
		const { context } = parseContext({
			glossary: [{ term: 'Board', aliases: ['Boards'], meaning: 'a page of cards in columns, not a wooden board', translations: { ta: 'OKWORD' }, avoid: { ta: ['BADWORD'] } }],
		});
		const view = (l: string) => termsIn('Delete all boards', l, context).map((h) => ({ target: h.target, meaning: h.meaning, avoid: h.avoid }));
		assert.deepEqual(view('ta'), [{ target: 'OKWORD', meaning: 'a page of cards in columns, not a wooden board', avoid: ['BADWORD'] }]);
		for (const l of ['es', 'fr', 'ar']) {
			assert.deepEqual(view(l), [{ target: undefined, meaning: 'a page of cards in columns, not a wooden board', avoid: undefined }], l);
		}
	});

	await scenario('termsIn: a language without an approved word still gets the meaning; one with an approved word gets both', () => {
		const { context } = parseContext({ glossary: [{ term: 'Board', aliases: ['Boards'], meaning: 'a page of cards in columns', translations: { es: 'tablero' } }] });
		const ta = termsIn('Delete all boards', 'ta', context);
		assert.deepEqual(ta.map((h) => [h.term, h.target, h.meaning]), [['Board', undefined, 'a page of cards in columns']]);
		const es = termsIn('Delete all boards', 'es', context);
		assert.deepEqual(es.map((h) => [h.term, h.target, h.meaning]), [['Board', 'tablero', 'a page of cards in columns']]);
		assert.deepEqual(termsIn('Nothing here', 'ta', context), []);
	});

	await scenario('termsIn: whole words only, case-insensitive, aliases, per-locale target', () => {
		const { context } = parseContext({
			glossary: [{ term: 'Board', aliases: ['Boards'], note: 'a page of cards in columns', translations: { ta: 'பலகை', es: 'tablero' } }],
			doNotTranslate: ['Acme', { term: 'Beta', translations: { ar: 'بيتا' } }],
		});
		const hit = (t: string, l: string) => termsIn(t, l, context).map((h) => `${h.kind}:${h.term}=${h.target}`);
		assert.deepEqual(hit('Create a new board', 'ta'), ['glossary:Board=பலகை']);
		assert.deepEqual(hit('All Boards are shown', 'es'), ['glossary:Board=tablero']);
		assert.deepEqual(hit('Dashboard and onboard', 'es'), [], 'must not match inside other words');
		assert.deepEqual(hit('Create a new board', 'fr'), ['glossary:Board=undefined'], 'no approved word for fr, but the meaning is still passed on');
		const bare = parseContext({ glossary: [{ term: 'Board', translations: { es: 'tablero' } }] }).context;
		assert.deepEqual(termsIn('Create a new board', 'fr', bare), [], 'no approved word and no meaning: nothing to say about it');
		assert.deepEqual(hit('Welcome to Acme', 'ta'), ['keep:Acme=Acme']);
		assert.deepEqual(hit('Welcome to Beta', 'ar'), ['keep:Beta=بيتا']);
		assert.deepEqual(hit('Welcome to Beta', 'es'), ['keep:Beta=Beta']);
	});

	await scenario('multi-word terms match across whitespace', () => {
		const { context } = parseContext({ glossary: [{ term: 'Service Request', translations: { es: 'solicitud de servicio' } }] });
		assert.equal(termsIn('Open the service   request form', 'es', context).length, 1);
	});

	await scenario('usesApproved: exact, case-insensitive, and inflected stems', () => {
		assert.ok(usesApproved('Crear un tablero nuevo', 'tablero'));
		assert.ok(usesApproved('Crear un TABLERO nuevo', 'tablero'));
		assert.ok(usesApproved('புதிய ஓட்டத்தை உருவாக்கு', 'ஓட்டம்'), 'Tamil case ending keeps the stem');
		assert.ok(!usesApproved('Crear un panel nuevo', 'tablero'));
		// multi-word terms: plural / inflected forms count, a different word does not
		assert.ok(usesApproved('Las tarjetas de crédito vencidas se rechazan', 'tarjeta de crédito'));
		assert.ok(usesApproved('Crear una tarjeta de crédito', 'tarjeta de crédito'));
		assert.ok(!usesApproved('Crear una tarjeta de débito', 'tarjeta de crédito'));
		assert.ok(!usesApproved('Las tarjetas de débito vencidas se rechazan', 'tarjeta de crédito'));
		assert.ok(usesApproved('தோல்வியுற்ற பணிப்பாய்வுகள் மீண்டும் முயற்சிக்கப்படும்', 'பணிப்பாய்வு'), 'Tamil plural');
		assert.ok(usesApproved('புதிய பணிப்பாய்வை உருவாக்கவும்', 'பணிப்பாய்வு'), 'Tamil accusative');
		assert.ok(usesApproved('anything', ''));
	});

	await scenario('styleFor: locale rule wins over default', () => {
		const { context } = parseContext({ style: { default: 'polite', locales: { es: 'usted' } } });
		assert.equal(styleFor('es', context), 'usted');
		assert.equal(styleFor('fr', context), 'polite');
	});

	done();
})();
