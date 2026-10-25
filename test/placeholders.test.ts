import { placeholdersOf, protect, restore, samePlaceholders } from '../src/placeholders';
import { assert, done, scenario } from './helper';

(async () => {
	await scenario('adjacent placeholders are masked as one token so translators cannot leave stray underscores', () => {
		const { masked, tokens } = protect('Welcome to Acme, <b>{{name}}</b>');
		assert.equal(masked, 'Welcome to Acme, __PH0__');
		assert.deepEqual(tokens, ['<b>{{name}}</b>']);
		assert.equal(restore('Bienvenido a Acme, __PH0__', tokens), 'Bienvenido a Acme, <b>{{name}}</b>');
	});

	await scenario('placeholders separated by text stay separate tokens and restore in any order', () => {
		const { masked, tokens } = protect('Click <b>here</b> for {{count}} items');
		assert.equal(tokens.length, 3);
		assert.equal(masked, 'Click __PH0__here__PH1__ for __PH2__ items');
		assert.equal(restore('__PH2__ elementos: __PH0__aquí__PH1__', tokens), '{{count}} elementos: <b>aquí</b>');
	});

	await scenario('a lost or invented token makes restore return null', () => {
		const { tokens } = protect('Hello {{name}}');
		assert.equal(restore('Hola', tokens), null);
		assert.equal(restore('Hola __PH7__', tokens), null);
	});

	await scenario('samePlaceholders compares the real placeholders, ignoring order', () => {
		assert.ok(samePlaceholders('<b>{{n}}</b> of {{m}}', '{{m}} de <b>{{n}}</b>'));
		assert.ok(!samePlaceholders('<b>{{n}}</b>', '<b>{{x}}</b>'));
		assert.deepEqual(placeholdersOf('a %s b {{c}}'), ['%s', '{{c}}']);
	});

	done();
})();
