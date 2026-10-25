import { AiEngine } from '../src/ai/engine';
import { LlmClient, LlmError } from '../src/ai/clients';
import { parseContext } from '../src/context';
import { assert, done, scenario } from './helper';

/** Items the prompt asks about: lines that look like {"id":"s0","key":"...","text":"..."} */
function itemsIn(prompt: string): { id: string; text: string; previous?: string; draft?: string }[] {
	return prompt
		.split('\n')
		.filter((l) => l.startsWith('{"id":'))
		.map((l) => JSON.parse(l));
}

class FakeClient implements LlmClient {
	prompts: string[] = [];
	constructor(
		readonly label: string,
		private readonly answer: (prompt: string, call: number) => string | Error,
	) {}
	async complete(prompt: string): Promise<string> {
		this.prompts.push(prompt);
		const a = this.answer(prompt, this.prompts.length);
		if (a instanceof Error) {
			throw a;
		}
		return a;
	}
}

/** "Translate" by wrapping the text: es( ... ) and keep placeholders untouched. */
const wrap = (t: string) => `es(${t})`;
const reply = (prompt: string, f: (text: string, id: string) => string = wrap) =>
	JSON.stringify(Object.fromEntries(itemsIn(prompt).map((i) => [i.id, f(i.text, i.id)])));

const ctx = parseContext({
	glossary: [{ term: 'Board', translations: { es: 'tablero' } }],
	doNotTranslate: ['Acme'],
}).context;
const mk = (clients: LlmClient[], extra: Partial<ConstructorParameters<typeof AiEngine>[0]> = {}) =>
	new AiEngine({
		clients,
		context: ctx,
		sourceLocale: 'en',
		reviewPass: false,
		log: () => undefined,
		timing: { rateBackoffMs: 1, maxRateRetries: 3, maxTransientRetries: 1 },
		...extra,
	});
const items = (...texts: string[]) => texts.map((text, i) => ({ id: `s${i}`, text, keyPath: `k.${i}` }));
const req = (its = items('Save changes', 'Hello {{name}}')) => ({ locale: 'es', file: 'a.json', items: its, refs: [] });

(async () => {
	await scenario('happy path: one request, every string answered and ok', async () => {
		const c = new FakeClient('m1', (p) => reply(p));
		const e = mk([c]);
		const res = await e.translate(req());
		assert.equal(c.prompts.length, 1);
		assert.equal(res.get('s0')?.value, 'es(Save changes)');
		assert.ok([...res.values()].every((r) => r.ok && r.model === 'm1'));
	});

	await scenario('a lost placeholder is sent back with the reason and fixed on the retry', async () => {
		const c = new FakeClient('m1', (p, n) => (n === 1 ? reply(p, () => 'Hola') : reply(p, (t) => `Hola ${t.includes('{{name}}') ? '{{name}}' : ''}`.trim())));
		const res = await mk([c]).translate(req(items('Hello {{name}}')));
		assert.equal(c.prompts.length, 2);
		assert.match(c.prompts[1], /placeholders were changed, lost or added/);
		assert.match(c.prompts[1], /"previous":"Hola"/);
		assert.equal(res.get('s0')?.value, 'Hola {{name}}');
		assert.ok(res.get('s0')?.ok);
	});

	await scenario('a missing approved glossary term (soft problem) is corrected on retry', async () => {
		const c = new FakeClient('m1', (p, n) => reply(p, () => (n === 1 ? 'Crear un panel' : 'Crear un tablero')));
		const res = await mk([c]).translate(req(items('Create a board')));
		assert.match(c.prompts[1], /approved translation \\"tablero\\"/);
		assert.equal(res.get('s0')?.value, 'Crear un tablero');
		assert.deepEqual(res.get('s0')?.problems, []);
	});

	await scenario('a persistent soft problem still returns the text (ok) but lists the problem; a persistent hard problem is not ok', async () => {
		const soft = await mk([new FakeClient('m', (p) => reply(p, () => 'Crear un panel'))]).translate(req(items('Create a board')));
		assert.ok(soft.get('s0')?.ok);
		assert.equal(soft.get('s0')?.problems.length, 1);
		const hard = await mk([new FakeClient('m', (p) => reply(p, () => 'Hola'))]).translate(req(items('Hello {{name}}')));
		assert.equal(hard.get('s0')?.ok, false);
	});

	await scenario('the retry is only accepted when it is not worse than the first answer', async () => {
		// first answer has a soft problem; the retry loses a placeholder (hard) -> keep the first
		const c = new FakeClient('m', (p, n) => reply(p, () => (n === 1 ? 'Hola {{name}}' : 'Hola')));
		const res = await mk([c]).translate(req(items('Hello {{name}}.')));
		assert.equal(res.get('s0')?.value, 'Hola {{name}}');
	});

	await scenario('review pass: a better proofread answer replaces the draft, a worse one is rejected', async () => {
		const c = new FakeClient('m', (p, n) => {
			if (n === 1) {
				return reply(p, (t) => (t === 'Save' ? 'Salvar' : 'Hola {{name}}'));
			}
			// review: improve the first, break the placeholder in the second
			return JSON.stringify({ s0: 'Guardar', s1: 'Hola' });
		});
		const res = await mk([c], { reviewPass: true }).translate(req(items('Save', 'Hello {{name}}')));
		assert.equal(c.prompts.length, 2);
		assert.match(c.prompts[1], /You are now the reviewer/);
		assert.equal(res.get('s0')?.value, 'Guardar');
		assert.equal(res.get('s1')?.value, 'Hola {{name}}', 'review that loses the placeholder is ignored');
	});

	await scenario('a rate-limited model is waited for and retried, then succeeds', async () => {
		let n = 0;
		const c = new FakeClient('m', (p) => (++n <= 2 ? new LlmError('429', 'rate', 1) : reply(p)));
		const res = await mk([c]).translate(req());
		assert.equal(c.prompts.length, 3);
		assert.equal(res.size, 2);
	});

	await scenario('a model that cannot be used is skipped for good and the next model answers', async () => {
		const bad = new FakeClient('no-access', () => new LlmError('NoPermissions', 'unavailable'));
		const good = new FakeClient('good', (p) => reply(p));
		const e = mk([bad, good]);
		const r1 = await e.translate(req());
		assert.equal(r1.get('s0')?.model, 'good');
		await e.translate(req());
		assert.equal(bad.prompts.length, 1, 'not asked again');
	});

	await scenario('every model unusable -> empty result and usable() is false', async () => {
		const e = mk([new FakeClient('a', () => new LlmError('x', 'unavailable')), new FakeClient('b', () => new LlmError('y', 'unavailable'))]);
		assert.equal((await e.translate(req())).size, 0);
		assert.equal(e.usable(), false);
	});

	await scenario('a model that keeps failing is dropped after the retry limit', async () => {
		const c = new FakeClient('flaky', () => new LlmError('HTTP 500', 'transient'));
		const e = mk([c]);
		assert.equal((await e.translate(req())).size, 0);
		assert.equal(c.prompts.length, 2, '1 try + 1 retry');
		assert.equal(e.usable(), false);
	});

	await scenario('malformed JSON, then a good answer: asks again', async () => {
		const c = new FakeClient('m', (p, n) => (n === 1 ? 'Sorry, I cannot do that' : reply(p)));
		const res = await mk([c]).translate(req());
		assert.equal(res.size, 2);
		assert.equal(c.prompts.length, 2);
	});

	await scenario('ids missing from the answer are requested again on their own', async () => {
		const c = new FakeClient('m', (p, n) => {
			const its = itemsIn(p);
			return n === 1 ? JSON.stringify({ [its[0].id]: wrap(its[0].text) }) : reply(p);
		});
		const res = await mk([c]).translate(req(items('One', 'Two', 'Three')));
		assert.equal(res.size, 3);
		assert.equal(itemsIn(c.prompts[1]).length, 2, 'only the two missing strings were asked for again');
	});

	await scenario('big sets are split into several requests (item limit and prompt size limit)', async () => {
		const c = new FakeClient('m', (p) => reply(p));
		const res = await mk([c], { maxBatchItems: 2 }).translate(req(items('a1', 'b2', 'c3', 'd4', 'e5')));
		assert.equal(c.prompts.length, 3);
		assert.equal(res.size, 5);
		const small = new FakeClient('s', (p) => reply(p));
		(small as { maxPromptChars?: number }).maxPromptChars = 200;
		await mk([small]).translate(req(items('x'.repeat(100), 'y'.repeat(100), 'z'.repeat(100))));
		assert.ok(small.prompts.length >= 2, 'client prompt limit splits the work');
	});

	await scenario('when the time budget is spent no more requests are sent', async () => {
		const c = new FakeClient('m', (p) => reply(p));
		const res = await mk([c], { stop: () => true }).translate(req());
		assert.equal(c.prompts.length, 0);
		assert.equal(res.size, 0);
	});

	await scenario('jargon: a Latin-script string the model keeps unchanged is accepted once the model confirms it; a wrong script never is', async () => {
		const jargon = 'API Gateway Webhook Timeout';
		const c = new FakeClient('m', (p) => reply(p, (t) => t));
		const res = await mk([c]).translate(req(items(jargon)));
		assert.equal(res.get('s0')?.value, jargon);
		assert.ok(res.get('s0')?.ok, 'accepted');
		assert.match(res.get('s0')!.problems.join(' '), /confirmed/);
		assert.equal(c.prompts.length, 2, 'one retry asked the model to confirm, no more');
		// Tamil must be in Tamil script: re-affirming English is not accepted
		const bad = new FakeClient('m', (p) => reply(p, (t) => t));
		const r2 = await mk([bad]).translate({ locale: 'ta', file: 'a.json', items: items('Delete this item'), refs: [] });
		assert.equal(r2.get('s0')?.ok, false);
	});

	await scenario('the prompt tells the model about the glossary term and the key path', async () => {
		const c = new FakeClient('m', (p) => reply(p));
		await mk([c]).translate({ locale: 'es', file: 'x.json', items: [{ id: 's0', text: 'Open the board', keyPath: 'menu.openBoard' }], refs: [{ key: 'menu.close', source: 'Close', target: 'Cerrar' }] });
		assert.match(c.prompts[0], /"Board" => "tablero"/);
		assert.match(c.prompts[0], /"key":"menu\.openBoard"/);
		assert.match(c.prompts[0], /"es":"Cerrar"/);
	});

	await scenario('a model whose daily quota is used up is left alone for the run and the next model answers (no waiting)', async () => {
		const out = new FakeClient('out-of-quota', () => new LlmError('daily quota used up', 'quota'));
		const next = new FakeClient('next', (p) => reply(p));
		const e = mk([out, next]);
		const r = await e.translate(req());
		assert.equal(r.get('s0')?.model, 'next');
		await e.translate(req());
		assert.equal(out.prompts.length, 1, 'not asked again');
	});

	done();
})();
