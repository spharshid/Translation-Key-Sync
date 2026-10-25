import * as http from 'node:http';
import * as path from 'node:path';
import { detectOllama } from '../src/ai/local';
import { parseContext } from '../src/context';
import { applyManualAnswer, buildManualPrompt } from '../src/manualAi';
import { PendingEntry, PendingStore } from '../src/pending';
import { json, readJson, tmp, W, R } from './fixtures';
import { assert, done, scenario } from './helper';

const ctx = parseContext({ appContext: 'A web app.', glossary: [{ term: 'Board', translations: { es: 'tablero' } }] }).context;

/** destination with en + es, es holding English/machine placeholders that are queued */
async function world() {
	const root = tmp();
	const dir = path.join(root, 'locales');
	const f = (l: string, rel: string) => path.join(dir, l, rel);
	W(f('en', 'a.json'), json({ buttons: { save: 'Save', cancel: 'Cancel' }, msg: { hello: 'Hello {{name}}', board: 'Create a board' } }));
	W(f('es', 'a.json'), json({ buttons: { save: 'Guardar', cancel: 'Cancel' }, msg: { hello: 'Hello {{name}}', board: 'Create a board' } }));
	const store = new PendingStore(path.join(root, 'p.json'));
	const entry = (p: (string | number)[], text: string, locale = 'es', file = f('es', 'a.json')): PendingEntry => ({ file, path: p, text, locale, since: 1, kind: 'english', written: text });
	await store.add([entry(['buttons', 'cancel'], 'Cancel'), entry(['msg', 'hello'], 'Hello {{name}}'), entry(['msg', 'board'], 'Create a board')]);
	return { dir, f, store, entry };
}

(async () => {
	await scenario('the prompt has the strings with key paths, the approved references from the file, the glossary and the reply rules', async () => {
		const w = await world();
		const built = await buildManualPrompt(w.store, w.dir, 'en', ctx);
		assert.ok(built);
		const p = built!.prompt;
		assert.match(p, /"id":"p0","key":"buttons\.cancel","text":"Cancel"/);
		assert.match(p, /"key":"msg\.hello"/);
		assert.match(p, /"en":"Save"[^\n]*"es":"Guardar"|"es":"Guardar"/, 'the approved Save -> Guardar is a reference');
		assert.match(p, /"Board" => "tablero"/);
		assert.match(p, /Reply with the JSON object only/);
		assert.equal(built!.awaiting.locale, 'es');
		assert.equal(built!.awaiting.items.length, 3);
		assert.equal(built!.remaining, 0);
	});

	await scenario('nothing queued -> no prompt; big queues are split and the rest is reported', async () => {
		const w = await world();
		const empty = new PendingStore(path.join(tmp(), 'e.json'));
		assert.equal(await buildManualPrompt(empty, w.dir, 'en', ctx), null);
		const built = await buildManualPrompt(w.store, w.dir, 'en', ctx, 2);
		assert.equal(built!.awaiting.items.length, 2);
		assert.equal(built!.remaining, 1);
	});

	await scenario('a good pasted reply is validated and written; entries leave the queue; formatting is kept', async () => {
		const w = await world();
		const built = (await buildManualPrompt(w.store, w.dir, 'en', ctx))!;
		const reply = '```json\n' + JSON.stringify({ p0: 'Cancelar', p1: 'Hola {{name}}', p2: 'Crear un tablero' }) + '\n```';
		const res = (await applyManualAnswer(w.store, built.awaiting, reply, ctx))!;
		assert.equal(res.applied, 3);
		assert.equal(res.rejected.length, 0);
		const es = readJson(w.f('es', 'a.json'));
		assert.equal(es.buttons.cancel, 'Cancelar');
		assert.equal(es.msg.hello, 'Hola {{name}}');
		assert.equal(es.buttons.save, 'Guardar', 'other keys untouched');
		assert.equal(await w.store.count(), 0);
	});

	await scenario('bad answers (lost placeholder, still English, wrong glossary term) are rejected and stay queued; good ones still apply', async () => {
		const w = await world();
		const built = (await buildManualPrompt(w.store, w.dir, 'en', ctx))!;
		const res = (await applyManualAnswer(w.store, built.awaiting, JSON.stringify({ p0: 'Cancelar', p1: 'Hola', p2: 'Crear un panel' }), ctx))!;
		assert.equal(res.applied, 2, 'the glossary miss is only a soft problem, so it is written');
		assert.equal(res.rejected.length, 1);
		assert.match(res.rejected[0].problems.join(' '), /placeholders/);
		const es = readJson(w.f('es', 'a.json'));
		assert.equal(es.msg.hello, 'Hello {{name}}', 'rejected one untouched');
		assert.equal(await w.store.count(), 1, 'only the rejected one is still waiting');
	});

	await scenario('ids missing from the reply stay queued; garbage is reported as null; a hand edit made meanwhile is never overwritten', async () => {
		const w = await world();
		const built = (await buildManualPrompt(w.store, w.dir, 'en', ctx))!;
		assert.equal(await applyManualAnswer(w.store, built.awaiting, 'sorry, I cannot', ctx), null);
		// someone fixes one by hand before the reply is applied
		W(w.f('es', 'a.json'), R(w.f('es', 'a.json')).replace('"Cancel"', '"Anular"'));
		const res = (await applyManualAnswer(w.store, built.awaiting, JSON.stringify({ p0: 'Cancelar', p1: 'Hola {{name}}' }), ctx))!;
		assert.equal(res.missing, 1);
		assert.equal(res.dropped, 1);
		assert.equal(res.applied, 1);
		assert.equal(readJson(w.f('es', 'a.json')).buttons.cancel, 'Anular');
		assert.equal(await w.store.count(), 1, 'only the missing id is still waiting');
	});

	// ---- local Ollama detection
	const server = http.createServer((req, res) => {
		res.setHeader('Content-Type', 'application/json');
		if (req.url === '/api/tags') {
			res.end(JSON.stringify({ models: models }));
		} else {
			res.statusCode = 404;
			res.end('{}');
		}
	});
	let models: { name: string }[] = [];
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

	await scenario('local Ollama: picks the best general model, never an embedding model; none or unreachable -> undefined', async () => {
		models = [{ name: 'nomic-embed-text:latest' }, { name: 'phi3:mini' }, { name: 'llama3.1:8b' }, { name: 'qwen2.5:7b' }];
		const c = await detectOllama(base);
		assert.match(c!.label, /qwen2\.5:7b/);
		assert.equal(c!.maxPromptChars, 5000);
		models = [{ name: 'bge-m3' }];
		assert.equal(await detectOllama(base), undefined);
		models = [];
		assert.equal(await detectOllama(base), undefined);
		assert.equal(await detectOllama('http://127.0.0.1:1'), undefined);
	});

	server.closeAllConnections?.();
	server.close();
	done();
})();
