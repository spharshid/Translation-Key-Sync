import * as http from 'node:http';
import { LlmError } from '../src/ai/clients';
import { PooledClient } from '../src/ai/pool';
import { assert, done, scenario } from './helper';

type Reply = { status: number; headers?: Record<string, string>; body?: unknown };
let behave: (model: string, call: number) => Reply = () => ({ status: 200 });
const used: string[] = [];
let lastBody: Record<string, unknown> = {};
const server = http.createServer((req, res) => {
	let b = '';
	req.on('data', (c) => (b += c));
	req.on('end', () => {
		lastBody = JSON.parse(b);
		const model = lastBody.model as string;
		used.push(model);
		const r = behave(model, used.length);
		res.writeHead(r.status, { 'Content-Type': 'application/json', ...(r.headers ?? {}) });
		res.end(JSON.stringify(r.body ?? { choices: [{ message: { content: `from ${model}` } }] }));
	});
});

const rateBody = (retry: string, quotaId: string) => [
	{ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: retry }, { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId }] }] } },
];
const perMinute = (retry = '23s'): Reply => ({ status: 429, body: rateBody(retry, 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier') });
const perDay: Reply = { status: 429, body: rateBody('40s', 'GenerateRequestsPerDayPerProjectPerModel-FreeTier') };

function pool(models: string[], maxWaitMs?: number, reasoningEffort?: string) {
	let t = 5_000_000;
	const sleeps: number[] = [];
	const c = new PooledClient({
		baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
		models,
		apiKey: 'k',
		now: () => t,
		sleep: async (ms) => {
			sleeps.push(ms);
			t += ms;
		},
		maxWaitMs,
		reasoningEffort,
	});
	return { c, sleeps, advance: (ms: number) => (t += ms) };
}
const reset = () => {
	used.length = 0;
	behave = () => ({ status: 200 });
};
const kindOf = async (p: Promise<unknown>) => {
	try {
		await p;
		return 'ok';
	} catch (e) {
		return e instanceof LlmError ? e.kind : 'other';
	}
};

(async () => {
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));

	await scenario('the first model is used until it is rate limited, then the next one; the first returns once its wait is over', async () => {
		reset();
		behave = (m, n) => (m === 'flash' && n === 1 ? perMinute('23s') : { status: 200 });
		const { c, advance } = pool(['flash', 'lite', 'older']);
		assert.equal(await c.complete('p'), 'from lite');
		assert.deepEqual(used, ['flash', 'lite']);
		assert.equal(await c.complete('p'), 'from lite', 'flash still resting');
		advance(24_000);
		assert.equal(await c.complete('p'), 'from flash');
	});

	await scenario('a model whose DAILY quota is gone is skipped for a long time (not waited for); all of them gone -> a quota error at once', async () => {
		reset();
		behave = (m) => (m === 'flash' ? perDay : { status: 200 });
		const { c, sleeps } = pool(['flash', 'lite']);
		assert.equal(await c.complete('p'), 'from lite');
		await c.complete('p');
		assert.equal(used.filter((m) => m === 'flash').length, 1, 'flash was asked once, then left alone');
		behave = () => perDay;
		assert.equal(await kindOf(c.complete('p')), 'quota');
		assert.equal(sleeps.length, 0, 'no waiting for a quota that resets tomorrow');
	});

	await scenario('every model rate limited: waits for the first to recover and carries on; gives up with a rate error past the cap', async () => {
		reset();
		let limited = 2;
		behave = () => (limited-- > 0 ? perMinute('10s') : { status: 200 });
		const a = pool(['flash', 'lite']);
		assert.equal(await a.c.complete('p'), 'from flash');
		assert.ok(a.sleeps.length >= 1 && a.sleeps[0] >= 9_000 && a.sleeps[0] <= 12_000, JSON.stringify(a.sleeps));
		reset();
		behave = () => perMinute('300s');
		assert.equal(await kindOf(pool(['flash', 'lite'], 20_000).c.complete('p')), 'rate');
	});

	await scenario('an unknown model (404) is dropped; none left -> unavailable; a server error passes through as transient', async () => {
		reset();
		behave = (m) => (m === 'typo' ? { status: 404, body: {} } : { status: 200 });
		const { c } = pool(['typo', 'flash']);
		assert.equal(await c.complete('p'), 'from flash');
		assert.equal(await c.complete('p'), 'from flash');
		assert.equal(used.filter((m) => m === 'typo').length, 1);
		reset();
		behave = () => ({ status: 401, body: {} });
		assert.equal(await kindOf(pool(['a', 'b']).c.complete('p')), 'unavailable');
		reset();
		behave = () => ({ status: 503, body: {} });
		assert.equal(await kindOf(pool(['a', 'b']).c.complete('p')), 'transient');
	});

	await scenario('an overloaded or timing-out model (HTTP 503) is skipped for a moment: the next model answers in the same call, and the first is tried again after its pause', async () => {
		reset();
		behave = (m, n) => (m === 'big' && n === 1 ? { status: 503, body: [{ error: { code: 503, message: 'This model is currently experiencing high demand' } }] } : { status: 200 });
		const { c, advance } = pool(['big', 'mid', 'lite']);
		assert.equal(await c.complete('p'), 'from mid');
		assert.deepEqual(used, ['big', 'mid'], 'no second try on the overloaded model');
		assert.equal(await c.complete('p'), 'from mid', 'big is resting');
		advance(31_000);
		assert.equal(await c.complete('p'), 'from big', 'back after its pause');
	});

	await scenario('every model overloaded: each is tried once and the error goes to the caller, which retries later', async () => {
		reset();
		behave = () => ({ status: 503, body: {} });
		assert.equal(await kindOf(pool(['a', 'b', 'c']).c.complete('p')), 'transient');
		assert.deepEqual(used, ['a', 'b', 'c']);
	});

	await scenario('the reasoning effort is only sent when it is configured', async () => {
		reset();
		await pool(['flash']).c.complete('p');
		assert.ok(!('reasoning_effort' in lastBody), 'not sent by default');
		await pool(['flash'], undefined, 'low').c.complete('p');
		assert.equal(lastBody.reasoning_effort, 'low');
	});

	await scenario('describe() names the model that actually answered, also after the pool moved on from a limited one', async () => {
		reset();
		behave = (m, n) => (m === 'flash' && n === 1 ? perMinute('23s') : { status: 200 });
		const { c } = pool(['flash', 'lite']);
		assert.equal(c.describe(), c.label, 'before any answer it falls back to the label');
		await c.complete('p');
		assert.equal(c.describe(), 'lite', 'flash was limited, lite answered');
	});

	server.closeAllConnections?.();
	server.close();
	done();
})();
