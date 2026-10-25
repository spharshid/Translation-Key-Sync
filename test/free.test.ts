import * as http from 'node:http';
import { LlmError } from '../src/ai/clients';
import { FreeEndpointClient } from '../src/ai/free';
import { assert, done, scenario } from './helper';

type Behaviour = (model: string, call: number) => { status: number; retryAfter?: number; body?: unknown };
let listing: string[] = [];
let listingStatus = 200;
let behave: Behaviour = () => ({ status: 200 });
const used: string[] = [];

const server = http.createServer((req, res) => {
	let b = '';
	req.on('data', (c) => (b += c));
	req.on('end', () => {
		res.setHeader('Content-Type', 'application/json');
		if (req.url === '/v1/models') {
			res.statusCode = listingStatus;
			return void res.end(JSON.stringify({ data: listing.map((id) => ({ id })) }));
		}
		const model = JSON.parse(b).model as string;
		used.push(model);
		const r = behave(model, used.length);
		res.statusCode = r.status;
		if (r.retryAfter) {
			res.setHeader('Retry-After', String(r.retryAfter));
		}
		res.end(JSON.stringify(r.body ?? { choices: [{ message: { content: `answer from ${model}` } }] }));
	});
});

const ALL = ['Qwen3Guard-Gen-0.6B', 'bge-m3', 'Qwen2.5-VL-72B-Instruct', 'nvr-tts-es-es', 'whisper-large-v3', 'Mistral-Small-3.2-24B-Instruct-2506', 'Meta-Llama-3_3-70B-Instruct', 'gpt-oss-120b', 'Qwen3.5-397B-A17B', 'stable-diffusion-xl-base-v10', 'gpt-oss-20b'];

/** a client on a fake clock: sleeping just moves time forward */
function client(extra: { maxWaitMs?: number } = {}) {
	let t = 1_000_000;
	const sleeps: number[] = [];
	const c = new FreeEndpointClient({
		baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
		now: () => t,
		sleep: async (ms) => {
			sleeps.push(ms);
			t += ms;
		},
		...extra,
	});
	return { c, sleeps, clock: () => t };
}
const reset = (models = ALL) => {
	used.length = 0;
	listing = models;
	listingStatus = 200;
	behave = () => ({ status: 200 });
};

(async () => {
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));

	await scenario('discovery keeps only measured chat models, best first; guard / embedding / vision / audio / image models are ignored', async () => {
		reset();
		const { c } = client();
		assert.deepEqual(await c.discover(), ['gpt-oss-120b', 'Qwen3.5-397B-A17B', 'Mistral-Small-3.2-24B-Instruct-2506', 'Meta-Llama-3_3-70B-Instruct', 'gpt-oss-20b']);
	});

	await scenario('requests start on the best model; each model is used twice a minute, then the next one takes over', async () => {
		reset();
		const { c, sleeps } = client();
		for (let i = 0; i < 8; i++) {
			await c.complete('p');
		}
		assert.deepEqual(used, ['gpt-oss-120b', 'gpt-oss-120b', 'Qwen3.5-397B-A17B', 'Qwen3.5-397B-A17B', 'Mistral-Small-3.2-24B-Instruct-2506', 'Mistral-Small-3.2-24B-Instruct-2506', 'Meta-Llama-3_3-70B-Instruct', 'Meta-Llama-3_3-70B-Instruct']);
		assert.equal(sleeps.length, 0, 'never had to wait while another model had room');
	});

	await scenario('when every model has used its two requests the client waits for the oldest slot, then carries on', async () => {
		reset(['gpt-oss-120b', 'Mistral-Small-3.2-24B-Instruct-2506']);
		const { c, sleeps, clock } = client();
		const start = clock();
		for (let i = 0; i < 5; i++) {
			await c.complete('p');
		}
		assert.equal(used.length, 5);
		assert.equal(sleeps.length, 1, 'one wait, after the 4th call');
		assert.ok(sleeps[0] >= 59_000 && sleeps[0] <= 62_000, 'waited about a minute: ' + sleeps[0]);
		assert.ok(clock() - start >= 59_000);
		assert.equal(used[4], 'gpt-oss-120b', 'the best model is free again first');
	});

	await scenario('a 429 from the service (someone else on the same IP) blocks that model for Retry-After and another model is used', async () => {
		reset();
		behave = (model) => (model === 'gpt-oss-120b' ? { status: 429, retryAfter: 40, body: { message: 'API rate limit exceeded' } } : { status: 200 });
		const { c } = client();
		const answer = await c.complete('p');
		assert.equal(answer, 'answer from Qwen3.5-397B-A17B');
		assert.deepEqual(used, ['gpt-oss-120b', 'Qwen3.5-397B-A17B']);
		await c.complete('p');
		assert.equal(used[2], 'Qwen3.5-397B-A17B', 'the blocked model is not retried straight away');
	});

	await scenario('a withdrawn model (404) is dropped; if none is left the error says the model cannot be used', async () => {
		reset(['gpt-oss-120b', 'Mistral-Small-3.2-24B-Instruct-2506']);
		behave = (model) => (model === 'gpt-oss-120b' ? { status: 404, body: {} } : { status: 200 });
		const { c } = client();
		assert.equal(await c.complete('p'), 'answer from Mistral-Small-3.2-24B-Instruct-2506');
		assert.deepEqual(await c.discover(), ['Mistral-Small-3.2-24B-Instruct-2506']);
		reset(['gpt-oss-120b']);
		behave = () => ({ status: 404, body: {} });
		await assert.rejects(
			() => client().c.complete('p'),
			(e: unknown) => e instanceof LlmError && e.kind === 'unavailable',
		);
	});

	await scenario('waiting is capped: if the allowance does not free up in time the error is a rate error', async () => {
		reset(['gpt-oss-120b']);
		const { c } = client({ maxWaitMs: 20_000 });
		await c.complete('p');
		await c.complete('p');
		await assert.rejects(
			() => c.complete('p'),
			(e: unknown) => e instanceof LlmError && e.kind === 'rate',
		);
	});

	await scenario('if the model listing is unavailable the best-known model names are tried', async () => {
		reset();
		listingStatus = 500;
		const { c } = client();
		assert.equal((await c.discover())[0], 'gpt-oss-120b');
		assert.equal(await c.complete('p'), 'answer from gpt-oss-120b');
	});

	await scenario('other failures (5xx) are passed on as transient so the engine can retry or move on', async () => {
		reset();
		behave = () => ({ status: 503, body: {} });
		await assert.rejects(
			() => client().c.complete('p'),
			(e: unknown) => e instanceof LlmError && e.kind === 'transient',
		);
	});

	server.closeAllConnections?.();
	server.close();
	done();
})();
