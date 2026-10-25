import { validateTranslation } from '../src/ai/validate';
import { TermHit } from '../src/context';
import { assert, done, scenario } from './helper';

const v = (src: string, out: string, loc: string, terms: TermHit[] = []) => validateTranslation(src, out, loc, terms);
const hard = (src: string, out: string, loc: string, terms?: TermHit[]) => v(src, out, loc, terms).hard.length > 0;

(async () => {
	await scenario('a good translation passes with no problems', () => {
		assert.deepEqual(v('Save changes', 'Guardar cambios', 'es'), { hard: [], soft: [] });
		assert.deepEqual(v('Hello {{name}}!', 'Hola {{name}}!', 'es'), { hard: [], soft: [] });
	});

	await scenario('placeholders: lost, changed, added or translated are hard failures; reordering is fine', () => {
		assert.ok(hard('Hello {{name}}', 'Hola', 'es'));
		assert.ok(hard('Hello {{name}}', 'Hola {{nombre}}', 'es'));
		assert.ok(hard('Hello', 'Hola {{x}}', 'es'));
		assert.ok(hard('Use %s items', 'Utilice %d elementos', 'es'));
		assert.ok(!hard('{{a}} of {{b}}', '{{b}} de {{a}}', 'es'));
		assert.ok(!hard('Click <b>here</b>', 'Haga clic <b>aquí</b>', 'es'));
		assert.ok(hard('Click <b>here</b>', 'Haga clic aquí', 'es'));
	});

	await scenario('untranslated English is caught (identical, or mostly the same words)', () => {
		assert.ok(hard('Delete this item permanently', 'Delete this item permanently', 'es'));
		assert.ok(hard('Delete this item permanently', 'Delete this item permanently now', 'fr'));
		assert.ok(!hard('Dashboard', 'Dashboard', 'es'), 'single word may legitimately be unchanged');
		assert.ok(!hard('OK', 'OK', 'es'));
	});

	await scenario('wrong script for non-Latin targets is caught', () => {
		assert.ok(hard('Delete this item', 'Delete this item', 'ta'));
		assert.ok(hard('Delete this item', 'Eliminar este elemento', 'ar'));
		assert.ok(!hard('Delete this item', 'இந்த உருப்படியை நீக்கு', 'ta'));
		assert.ok(!hard('Delete this item', 'احذف هذا العنصر', 'ar'));
		assert.ok(!hard('Hello {{name}}', 'வணக்கம் {{name}}', 'ta'), 'placeholder letters do not count against the script check');
		assert.ok(!hard('Welcome to Acme', 'Acme க்கு வரவேற்கிறோம்', 'ta', [{ kind: 'keep', term: 'Acme', target: 'Acme' }]));
	});

	await scenario('empty output is a hard failure; empty source is ignored', () => {
		assert.ok(hard('Save', '   ', 'es'));
		assert.deepEqual(v('', '', 'es'), { hard: [], soft: [] });
	});

	await scenario('soft problems: punctuation, whitespace, line breaks, length', () => {
		assert.ok(v('Are you sure?', 'Está seguro', 'es').soft.some((p) => /punctuation/.test(p)));
		assert.ok(v('Are you sure?', 'Está seguro?', 'es').soft.length === 0);
		assert.ok(v('Hello ', 'Hola', 'es').soft.some((p) => /whitespace/.test(p)));
		assert.ok(v('One\nTwo', 'Uno Dos', 'es').soft.some((p) => /line breaks/.test(p)));
		assert.ok(v('This is a reasonably long sentence.', 'Sí.', 'es').soft.some((p) => /length/.test(p)));
	});

	await scenario('glossary: approved term (incl. inflected) passes, a different word is flagged', () => {
		const avoided: TermHit = { kind: 'glossary', term: 'Board', target: 'tablero', avoid: ['junta'] };
		assert.ok(v('Delete this board', 'Eliminar esta junta', 'es', [avoided]).soft.some((s) => s.includes('must not use "junta"')), 'the wrong-sense word is flagged');
		assert.deepEqual(v('Delete this board', 'Eliminar este tablero', 'es', [avoided]).soft, [], 'the approved word passes');
		const avoidOnly: TermHit = { kind: 'glossary', term: 'Board', avoid: ['junta'] };
		assert.ok(v('Delete this board', 'Eliminar esta junta', 'es', [avoidOnly]).soft.length > 0, 'avoid works without an approved word');
		assert.deepEqual(v('Delete this board', 'Eliminar este panel', 'es', [avoidOnly]).soft, []);
		const inside: TermHit = { kind: 'glossary', term: 'Board', target: 'tablero de junta', avoid: ['junta'] };
		assert.deepEqual(v('Delete this board', 'Eliminar el tablero de junta', 'es', [inside]).soft, [], 'an avoid word that is part of the approved word is not held against it');
		const meaningOnly: TermHit = { kind: 'glossary', term: 'Board', meaning: 'a page of cards in columns' };
		assert.deepEqual(v('Delete this board', 'Eliminar este panel', 'es', [meaningOnly]).soft, [], 'a term without an approved word is not checked');
		const term: TermHit = { kind: 'glossary', term: 'Board', target: 'tablero' };
		assert.deepEqual(v('Create a board', 'Crear un tablero', 'es', [term]).soft, []);
		assert.ok(v('Create a board', 'Crear un panel', 'es', [term]).soft.some((p) => /approved translation/.test(p)));
		const keep: TermHit = { kind: 'keep', term: 'Acme', target: 'Acme' };
		assert.ok(v('Welcome to Acme', 'Bienvenido a Acmé', 'es', [keep]).soft.some((p) => /must stay/.test(p)));
	});

	done();
})();
