import * as http from 'node:http';
import { LlmClient, OpenAiCompatClient } from '../src/ai/clients';
import { AiEngine } from '../src/ai/engine';
import { Cancelled, isCancelled, throwIfAborted, waitUnlessAborted } from '../src/cancel';
import { EMPTY_CONTEXT } from '../src/context';
import { aiClient, makeService, startStubs } from './fixtures';
import { assert, done, scenario } from './helper';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const rejectsCancelled = async (p: Promise<unknown>) => {
	try {
		await p;
		return false;
	} catch (e) {
		return isCancelled(e);
	}
};

/** A model that is "thinking" for a long time unless the run is stopped. */
class SlowClient implements LlmClient {
	label = 'slow';
	calls = 0;
	async complete(_prompt: string, opts: { signal?: AbortSignal } = {}): Promise<string> {
		this.calls++;
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(resolve, 5000);
			opts.signal?.addEventListener('abort', () => {
				clearTimeout(timer);
				reject(new Cancelled());
			});
		});
		return '{}';
	}
}

(async () => {
	await scenario('waitUnlessAborted: waits normally, ends at once when already aborted, and ends early (as Cancelled) when aborted during the wait', async () => {
		const real = (ms: number) => sleep(ms);
		const t0 = Date.now();
		await waitUnlessAborted(real, 40, new AbortController().signal);
		assert.ok(Date.now() - t0 >= 30, 'a normal wait still waits');

		const aborted = new AbortController();
		aborted.abort();
		assert.ok(await rejectsCancelled(waitUnlessAborted(real, 5000, aborted.signal)), 'already aborted');
		assert.throws(() => throwIfAborted(aborted.signal), (e: unknown) => isCancelled(e));
		assert.doesNotThrow(() => throwIfAborted(undefined));

		const ctl = new AbortController();
		const began = Date.now();
		setTimeout(() => ctl.abort(), 60);
		assert.ok(await rejectsCancelled(waitUnlessAborted(real, 5000, ctl.signal)), 'aborted during the wait');
		assert.ok(Date.now() - began < 1500, 'it did not wait the full 5 seconds');
	});

	await scenario('a request already in flight is aborted at once and comes back as Cancelled, not as an error that would be retried', async () => {
		const server = http.createServer((_req, res) => {
			setTimeout(() => {
				res.setHeader('Content-Type', 'application/json');
				res.end(JSON.stringify({ choices: [{ message: { content: 'late' } }] }));
			}, 4000);
		});
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
		const client = new OpenAiCompatClient({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, model: 'm' });
		const ctl = new AbortController();
		const began = Date.now();
		setTimeout(() => ctl.abort(), 120);
		assert.ok(await rejectsCancelled(client.complete('p', { signal: ctl.signal })));
		assert.ok(Date.now() - began < 2500, 'returned long before the server answered');
		server.closeAllConnections?.();
		server.close();
	});

	await scenario('the AI engine raises Cancelled at the signal, asks the model no more, and does not retire the model', async () => {
		const client = new SlowClient();
		const ctl = new AbortController();
		const engine = new AiEngine({ clients: [client], context: EMPTY_CONTEXT, sourceLocale: 'en', reviewPass: false, log: () => undefined, signal: ctl.signal });
		const run = engine.translate({ locale: 'es', file: 'x.json', items: [{ id: 's0', text: 'Save', keyPath: 'a.b' }, { id: 's1', text: 'Cancel', keyPath: 'a.c' }], refs: [] });
		setTimeout(() => ctl.abort(), 60);
		assert.ok(await rejectsCancelled(run), 'translate raised Cancelled');
		assert.equal(client.calls, 1, 'no second request after the stop');
		assert.ok(engine.usable(), 'a stop is not a failure of the model');
	});

	await scenario('the service raises Cancelled instead of writing English or machine translation when the run is stopped', async () => {
		const stubs = await startStubs();
		const items = [{ id: 's0', text: 'Save', keyPath: 'a.b' }];
		// stopped before it starts
		const before = new AbortController();
		before.abort();
		assert.ok(await rejectsCancelled(makeService(stubs, { ai: [aiClient()], signal: before.signal }).translateBatch({ locale: 'es', file: 'x.json', items, refs: [] })));
		// stopped while the AI is working: the string must not come back as English or as a machine translation
		const ctl = new AbortController();
		const slow = new SlowClient();
		const run = makeService(stubs, { ai: [slow], signal: ctl.signal }).translateBatch({ locale: 'es', file: 'x.json', items, refs: [] });
		setTimeout(() => ctl.abort(), 60);
		assert.ok(await rejectsCancelled(run));
		stubs.close();
	});

	done();
})();
