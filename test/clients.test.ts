import * as http from 'node:http';
import { LlmError, OpenAiCompatClient } from '../src/ai/clients';
import { assert, done, scenario } from './helper';

type Handler = (body: any, headers: http.IncomingHttpHeaders, res: http.ServerResponse) => void;
let handler: Handler = () => undefined;
const server = http.createServer((req, res) => {
	let b = '';
	req.on('data', (c) => (b += c));
	req.on('end', () => handler(b ? JSON.parse(b) : {}, req.headers, res));
});

const send = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
	res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
	res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

(async () => {
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
	const client = (extra = {}) => new OpenAiCompatClient({ baseUrl: base, model: 'm-1', apiKey: 'secret', ...extra });
	const kind = async (p: Promise<unknown>) => {
		try {
			await p;
			return 'ok';
		} catch (e) {
			return e instanceof LlmError ? `${e.kind}${e.retryAfterMs ? `:${e.retryAfterMs}` : ''}` : 'other';
		}
	};

	await scenario('sends model, prompt and bearer key to /chat/completions and returns the text', async () => {
		let seen: any;
		let auth = '';
		handler = (body, headers, res) => {
			seen = body;
			auth = String(headers.authorization);
			send(res, 200, { choices: [{ message: { content: '{"s0":"Hola"}' } }] });
		};
		assert.equal(await client().complete('translate this'), '{"s0":"Hola"}');
		assert.equal(seen.model, 'm-1');
		assert.equal(seen.messages[0].content, 'translate this');
		assert.equal(auth, 'Bearer secret');
	});

	await scenario('no key configured (e.g. local Ollama): no Authorization header', async () => {
		let auth: string | undefined = 'unset';
		handler = (_b, headers, res) => {
			auth = headers.authorization;
			send(res, 200, { choices: [{ message: { content: 'x' } }] });
		};
		await new OpenAiCompatClient({ baseUrl: base, model: 'llama' }).complete('p');
		assert.equal(auth, undefined);
	});

	await scenario('HTTP 429 is a rate error and honours Retry-After', async () => {
		handler = (_b, _h, res) => send(res, 429, {}, { 'Retry-After': '7' });
		assert.equal(await kind(client().complete('p')), 'rate:7000');
		handler = (_b, _h, res) => send(res, 429, {});
		assert.equal(await kind(client().complete('p')), 'rate');
	});

	await scenario('401/403/404 mean "cannot use this model" (unavailable); 5xx and bad bodies are transient', async () => {
		for (const status of [401, 403, 404]) {
			handler = (_b, _h, res) => send(res, status, {});
			assert.equal(await kind(client().complete('p')), 'unavailable', String(status));
		}
		handler = (_b, _h, res) => send(res, 503, {});
		assert.equal(await kind(client().complete('p')), 'transient');
		handler = (_b, _h, res) => send(res, 200, '<html>not json</html>');
		assert.equal(await kind(client().complete('p')), 'transient');
		handler = (_b, _h, res) => send(res, 200, { choices: [] });
		assert.equal(await kind(client().complete('p')), 'transient');
	});

	await scenario('a dead endpoint is a transient error, not a crash', async () => {
		assert.equal(await kind(new OpenAiCompatClient({ baseUrl: 'http://127.0.0.1:1/v1', model: 'm' }).complete('p')), 'transient');
	});

	await scenario('a Google-style 429 is split into "wait and retry" (with its retryDelay) and "the daily quota is gone"', async () => {
		const body = (retry: string, quotaId: string) => [{ error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: [{ retryDelay: retry }, { violations: [{ quotaId }] }] } }];
		handler = (_b, _h, res) => send(res, 429, body('23s', 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier'));
		assert.equal(await kind(client().complete('p')), 'rate:23000');
		handler = (_b, _h, res) => send(res, 429, body('40s', 'GenerateRequestsPerDayPerProjectPerModel-FreeTier'));
		assert.equal(await kind(client().complete('p')), 'quota');
		handler = (_b, _h, res) => send(res, 429, { error: { message: 'Rate limit reached: 200000 tokens per day' } });
		assert.equal(await kind(client().complete('p')), 'quota', 'other providers say "per day" in the message');
	});

	server.closeAllConnections?.();
	server.close();
	done();
})();
