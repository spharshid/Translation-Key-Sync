import { keySlot, PRESETS, reasoningFor, resolveProvider } from '../src/ai/endpoint';
import { parseContext } from '../src/context';
import { assert, done, scenario } from './helper';

const shared = (ai: unknown) => parseContext({ ai }).context;

(async () => {
	await scenario('the shared endpoint in the shared context file is read (endpoint + model; the key is never part of it)', () => {
		const { context, problems } = parseContext({ ai: { endpoint: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', apiKey: 'must-be-ignored' } });
		assert.deepEqual(problems, []);
		assert.deepEqual(context.ai, { endpoint: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b' });
		assert.ok(!JSON.stringify(context).includes('must-be-ignored'));
	});

	await scenario('a bad endpoint is reported and ignored; a missing ai section is fine', () => {
		const bad = parseContext({ ai: { endpoint: 'groq.com', model: 'x' } });
		assert.equal(bad.context.ai, undefined);
		assert.equal(bad.problems.length, 1);
		assert.equal(parseContext({}).context.ai, undefined);
		assert.equal(parseContext({ ai: 'nope' }).context.ai, undefined);
	});

	const own = (provider: string, endpoint = '', model = '') => ({ provider, endpoint, model });
	const teamCtx = shared({ endpoint: 'https://team.example/v1', model: 'team-model' });
	const empty = parseContext({}).context;

	await scenario('custom: own base URL and model win; empty fields use what the team shares; a half-filled own endpoint is never silently replaced', () => {
		const mine = resolveProvider(own('custom', 'https://mine/v1', 'mine'), teamCtx);
		assert.deepEqual([mine?.provider, mine?.endpoint, mine?.models, mine?.from], ['custom', 'https://mine/v1', ['mine'], 'settings']);
		const team = resolveProvider(own('custom'), teamCtx);
		assert.deepEqual([team?.endpoint, team?.models, team?.from], ['https://team.example/v1', ['team-model'], 'context file']);
		assert.equal(resolveProvider(own('custom', 'https://mine/v1', ''), teamCtx), undefined);
		assert.equal(resolveProvider(own('custom'), shared({ endpoint: 'https://team.example/v1' })), undefined, 'the shared section needs both fields');
		assert.equal(resolveProvider(own('custom'), empty), undefined);
	});

	await scenario('automatic: only what the team shares in the context file; the personal fields are ignored', () => {
		assert.equal(resolveProvider(own('auto'), empty), undefined);
		assert.equal(resolveProvider(own('auto', 'https://mine/v1', 'mine'), empty), undefined);
		assert.equal(resolveProvider(own('auto'), teamCtx)?.endpoint, 'https://team.example/v1');
		assert.equal(resolveProvider(own('auto'), teamCtx)?.provider, 'custom', 'it uses the custom key slot');
	});

	await scenario('Gemini and Groq: built-in endpoint and model list, the models field overrides the list, the endpoint field is ignored', () => {
		const g = resolveProvider(own('gemini'), empty);
		assert.equal(g?.endpoint, PRESETS.gemini.endpoint);
		assert.deepEqual(g?.models, PRESETS.gemini.models);
		assert.ok((g?.models.length ?? 0) > 1, 'several models rotate behind one key');
		assert.deepEqual(resolveProvider(own('gemini', 'https://ignored/v1', 'm1, m2'), empty)?.models, ['m1', 'm2']);
		assert.equal(resolveProvider(own('gemini', 'https://ignored/v1', 'm1'), empty)?.endpoint, PRESETS.gemini.endpoint);
		const q = resolveProvider(own('groq'), teamCtx);
		assert.deepEqual([q?.provider, q?.endpoint], ['groq', PRESETS.groq.endpoint]);
	});

	await scenario('Ollama is not a hosted provider here (it is a local client built from its own fields)', () => {
		assert.equal(resolveProvider(own('ollama', 'http://127.0.0.1:11434', 'llama3.1'), teamCtx), undefined);
	});

	await scenario('reduced reasoning is requested only from Google\'s Gemini endpoint', () => {
		assert.equal(reasoningFor(PRESETS.gemini.endpoint), 'low');
		assert.equal(reasoningFor('https://generativelanguage.googleapis.com/v1beta/openai/'), 'low');
		for (const other of [PRESETS.groq.endpoint, 'https://api.openai.com/v1', 'http://127.0.0.1:11434/v1', 'not a url', '']) {
			assert.equal(reasoningFor(other), undefined, other);
		}
	});

	await scenario('every provider has its own key slot', () => {
		assert.deepEqual(['gemini', 'groq', 'custom'].map(keySlot), ['i18nSync.aiKey.gemini', 'i18nSync.aiKey.groq', 'i18nSync.aiKey.custom']);
		assert.equal(new Set(['gemini', 'groq', 'custom'].map(keySlot)).size, 3);
	});

	done();
})();
