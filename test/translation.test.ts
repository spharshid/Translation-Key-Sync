import { LlmError } from '../src/ai/clients';
import { parseContext } from '../src/context';
import { isTrivial } from '../src/translation';
import { FakeClient, aiClient, makeService, startStubs } from './fixtures';
import { assert, done, scenario } from './helper';

const it = (id: string, text: string, keyPath = `k.${id}`) => ({ id, text, keyPath });
const ctx = parseContext({ glossary: [{ term: 'Board', translations: { es: 'tablero' } }], doNotTranslate: ['Acme'] }).context;

(async () => {
	const stubs = await startStubs();
	const req = (items = [it('s0', 'Save changes'), it('s1', 'Hello {{name}}')], extra = {}) => ({ locale: 'es', file: 'a.json', items, refs: [], ...extra });

	await scenario('isTrivial: numbers, symbols and bare tags need no translation', () => {
		assert.ok(isTrivial('123') && isTrivial('{{count}}') && isTrivial('<br/>') && isTrivial(' - '));
		assert.ok(!isTrivial('Save') && !isTrivial('{{n}} items'));
	});

	await scenario('AI answers: origin ai, no machine translation touched', async () => {
		stubs.reset();
		const res = await makeService(stubs, { ai: [aiClient()] }).translateBatch(req());
		assert.equal(res.get('s0')?.origin, 'ai');
		assert.equal(res.get('s0')?.value, 'ai(Save changes)');
		assert.equal(stubs.st.g + stubs.st.b, 0);
	});

	await scenario('trivial strings are returned as they are without asking anyone', async () => {
		stubs.reset();
		const c = aiClient();
		const res = await makeService(stubs, { ai: [c] }).translateBatch(req([it('s0', '42'), it('s1', '{{count}}')]));
		assert.equal(res.get('s0')?.value, '42');
		assert.equal(res.get('s1')?.value, '{{count}}');
		assert.equal(c.prompts.length, 0);
	});

	await scenario('AI unavailable: falls back to machine translation, origin classic', async () => {
		stubs.reset();
		const dead = new FakeClient('dead', () => new LlmError('no access', 'unavailable'));
		const res = await makeService(stubs, { ai: [dead] }).translateBatch(req());
		assert.equal(res.get('s0')?.origin, 'classic');
		assert.match(res.get('s0')!.value, /^g\|es\|/);
		assert.equal(res.get('s1')?.value.includes('{{name}}'), true, 'placeholders survive the fallback');
	});

	await scenario('only the strings the AI could not do fall back; the rest stay AI', async () => {
		stubs.reset();
		// the model answers s0 well but ruins the placeholder of s1 every time
		const c = new FakeClient('m', (p) => JSON.stringify(Object.fromEntries(itemsIn2(p).map((i) => [i.id, i.text.includes('{{') ? 'Hola' : `ai(${i.text})`]))));
		const res = await makeService(stubs, { ai: [c] }).translateBatch(req());
		assert.equal(res.get('s0')?.origin, 'ai');
		assert.equal(res.get('s1')?.origin, 'classic');
		assert.ok(res.get('s1')!.value.includes('{{name}}'));
	});

	await scenario('glossary and kept names also protect the machine-translation fallback', async () => {
		stubs.reset();
		const dead = new FakeClient('dead', () => new LlmError('x', 'unavailable'));
		const res = await makeService(stubs, { ai: [dead], context: ctx }).translateBatch(req([it('s0', 'Create a board for Acme')]));
		const v = res.get('s0')!.value;
		assert.ok(v.includes('tablero'), 'approved term substituted: ' + v);
		assert.ok(v.includes('Acme'), 'name kept: ' + v);
		assert.equal(res.get('s0')?.origin, 'classic');
	});

	await scenario('no AI configured at all: machine translation, aiIntended false so nothing is queued for an AI redo', async () => {
		stubs.reset();
		const svc = makeService(stubs, { aiWanted: false });
		const res = await svc.translateBatch(req());
		assert.equal(res.get('s0')?.origin, 'classic');
		assert.equal(svc.aiIntended, false);
		assert.equal(makeService(stubs, { aiWanted: true }).aiIntended, true, 'wanted but not reachable still counts as intended');
	});

	await scenario('aiOnly: strings the AI cannot do come back as english instead of using machine translation', async () => {
		stubs.reset();
		const dead = new FakeClient('dead', () => new LlmError('x', 'unavailable'));
		const res = await makeService(stubs, { ai: [dead] }).translateBatch(req([it('s0', 'Save changes')], { aiOnly: true }));
		assert.equal(res.get('s0')?.origin, 'english');
		assert.equal(stubs.st.g + stubs.st.b, 0);
	});

	await scenario('everything down for the whole budget: origin english, value is the source text', async () => {
		stubs.reset();
		stubs.st.gMode = 'block429';
		const dead = new FakeClient('dead', () => new LlmError('x', 'unavailable'));
		const res = await makeService(stubs, { ai: [dead], budgetMs: 400 }).translateBatch(req());
		assert.equal(res.get('s0')?.origin, 'english');
		assert.equal(res.get('s0')?.value, 'Save changes');
	});

	stubs.close();
	done();
})();

function itemsIn2(prompt: string): { id: string; text: string }[] {
	return prompt
		.split('\n')
		.filter((l) => l.startsWith('{"id":'))
		.map((l) => JSON.parse(l));
}
