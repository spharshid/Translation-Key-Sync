import * as path from 'node:path';
import * as os from 'node:os';
import { buildMemory } from '../src/memory';
import { resolveUserPath } from '../src/paths';
import { aiClient, json, makeService, startStubs, tmp, W } from './fixtures';
import { assert, done, scenario } from './helper';

/** destination/locales/{en,es}/... */
function repo() {
	const root = tmp();
	const dir = path.join(root, 'locales');
	return { dir, f: (l: string, rel: string) => path.join(dir, l, rel) };
}

(async () => {
	await scenario('exact matches are reused across files; untranslated, ambiguous and placeholder-mismatched pairs are not', async () => {
		const r = repo();
		W(r.f('en', 'a.json'), json({ cancel: 'Cancel', save: 'Save', same: 'OK', ask: 'Delete {{name}}?', empty: 'Empty one', bad: 'Hello {{n}}' }));
		W(r.f('es', 'a.json'), json({ cancel: 'Cancelar', save: 'Guardar', same: 'OK', ask: '¿Eliminar {{name}}?', empty: '', bad: 'Hola' }));
		W(r.f('en', 'b.json'), json({ x: 'Cancel', y: 'Save', z: 'Save' }));
		W(r.f('es', 'b.json'), json({ x: 'Cancelar', y: 'Salvar', z: 'Guardar' }));
		const mem = await buildMemory(r.dir, ['en', 'es'], 'en');
		assert.equal(mem('es', 'Cancel'), 'Cancelar');
		assert.equal(mem('es', '  Cancel '), 'Cancelar', 'whitespace around the text does not matter');
		assert.equal(mem('es', 'Delete {{name}}?'), '¿Eliminar {{name}}?');
		assert.equal(mem('es', 'OK'), undefined, 'a value identical to the source is not a translation');
		assert.equal(mem('es', 'Empty one'), undefined);
		assert.equal(mem('es', 'Hello {{n}}'), undefined, 'placeholders must match');
		assert.equal(mem('es', 'Save'), 'Guardar', 'Guardar x2 clearly beats Salvar x1');
		assert.equal(mem('es', 'Never seen'), undefined);
		assert.equal(mem('fr', 'Cancel'), undefined, 'languages are separate');
	});

	await scenario('a genuine tie between two wordings is left to the translator', async () => {
		const r = repo();
		W(r.f('en', 'a.json'), json({ a: 'Open', b: 'Open' }));
		W(r.f('es', 'a.json'), json({ a: 'Abrir', b: 'Abierto' }));
		const mem = await buildMemory(r.dir, ['en', 'es'], 'en');
		assert.equal(mem('es', 'Open'), undefined);
	});

	await scenario('unconfirmed entries (English placeholders / machine translations awaiting an AI redo) are excluded', async () => {
		const r = repo();
		W(r.f('en', 'a.json'), json({ a: 'Cancel', b: 'Save' }));
		W(r.f('es', 'a.json'), json({ a: 'Cancelar', b: 'Salvar (machine)' }));
		const exclude = new Set([`${path.resolve(r.f('es', 'a.json'))}::b`]);
		const mem = await buildMemory(r.dir, ['en', 'es'], 'en', exclude);
		assert.equal(mem('es', 'Cancel'), 'Cancelar');
		assert.equal(mem('es', 'Save'), undefined);
	});

	await scenario('a missing or empty destination is fine', async () => {
		const mem = await buildMemory(path.join(tmp(), 'nope'), ['en', 'es'], 'en');
		assert.equal(mem('es', 'Cancel'), undefined);
	});

	await scenario('the service reuses memory first: origin memory, the AI is never asked about it', async () => {
		const stubs = await startStubs();
		const r = repo();
		W(r.f('en', 'a.json'), json({ cancel: 'Cancel' }));
		W(r.f('es', 'a.json'), json({ cancel: 'Cancelar' }));
		const ai = aiClient();
		const svc = makeService(stubs, { ai: [ai] });
		const mem = await buildMemory(r.dir, ['en', 'es'], 'en');
		(svc as unknown as { o: { memory: typeof mem } }).o.memory = mem;
		const res = await svc.translateBatch({
			locale: 'es',
			file: 'x.json',
			items: [
				{ id: 's0', text: 'Cancel', keyPath: 'buttons.cancel' },
				{ id: 's1', text: 'Brand new sentence here', keyPath: 'misc.new' },
			],
			refs: [],
		});
		assert.equal(res.get('s0')?.origin, 'memory');
		assert.equal(res.get('s0')?.value, 'Cancelar');
		assert.equal(res.get('s1')?.origin, 'ai');
		assert.ok(!ai.prompts[0].includes('"text":"Cancel"'), 'the remembered string was not sent to the model');
		stubs.close();
	});

	await scenario('resolveUserPath: ~ expands to the home folder, empty stays empty, relative parts are normalised', () => {
		assert.equal(resolveUserPath(''), '');
		assert.equal(resolveUserPath('   '), '');
		assert.equal(resolveUserPath('~/repo/locales'), path.join(os.homedir(), 'repo', 'locales'));
		assert.equal(resolveUserPath('~'), os.homedir());
		assert.equal(resolveUserPath('/a/b/../c'), path.normalize('/a/c'));
	});

	done();
})();
