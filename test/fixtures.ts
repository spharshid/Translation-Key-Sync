import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { AiEngine } from '../src/ai/engine';
import { LlmClient } from '../src/ai/clients';
import { ContextFile, EMPTY_CONTEXT } from '../src/context';
import { TranslationService } from '../src/translation';
import { ProviderHealth, Translator } from '../src/translator';

export const sh = (c: string, cwd: string) => execSync(c, { cwd, stdio: 'pipe' }).toString().trim();
export const W = (f: string, s: string) => {
	fs.mkdirSync(path.dirname(f), { recursive: true });
	fs.writeFileSync(f, s);
};
export const R = (f: string) => fs.readFileSync(f, 'utf8');
export const crlf = (s: string) => s.replace(/\n/g, '\r\n');
export const json = (o: unknown, eol = '\n') => JSON.stringify(o, null, 2).replace(/\n/g, eol) + eol;
export const readJson = (f: string) => JSON.parse(R(f).replace(/^﻿/, ''));
export const tmp = (p = 'tks-') => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), p)));

/** A throwaway git repo. `commit` stages everything and returns the new commit hash. */
export function makeRepo(dir: string) {
	fs.mkdirSync(dir, { recursive: true });
	sh('git init -q && git config user.email t@t && git config user.name t && git config core.autocrlf false', dir);
	return {
		dir,
		commit(msg = 'c') {
			sh(`git add -A && git commit -q --allow-empty -m "${msg}"`, dir);
			return sh('git rev-parse HEAD', dir);
		},
	};
}

/** Items the prompt asks about: lines that look like {"id":"s0","key":"...","text":"..."} */
export function itemsIn(prompt: string): { id: string; text: string; key?: string }[] {
	return prompt
		.split('\n')
		.filter((l) => l.startsWith('{"id":'))
		.map((l) => JSON.parse(l));
}

export class FakeClient implements LlmClient {
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

/** A model that "translates" every string with `f` (default: wraps it as ai(...)). */
export const aiClient = (f: (text: string, lang: string) => string = (t) => `ai(${t})`, label = 'fake-ai') =>
	new FakeClient(label, (p) => {
		const lang = /locale code "([^"]+)"/.exec(p)?.[1] ?? '??';
		return JSON.stringify(Object.fromEntries(itemsIn(p).map((i) => [i.id, f(i.text, lang)])));
	});

export const FAST = { googleBackoffBaseMs: 40, googleBackoffMaxMs: 300, googleBlockBaseMs: 60, googleBlockMaxMs: 400, googleEndpointBlockMs: 2000, googleMinIntervalMs: 0, wakeProbeMs: 300, wakeRequestTimeoutMs: 1000, wakeRetryMs: 120, wakeGiveUpMs: 30000, pollMs: 25 };

const fake = (t: string) => t.replace(/[aeiou]/g, 'x'); // a "machine translation" that always differs from the source and keeps __PHn__ tokens

export type BMode = 'ok' | 'asleep503' | 'asleep200' | 'hang' | 'garbage' | 'echo';
export type GMode = 'ok' | 'block429' | 'html200' | 'hang' | 'merge';

/** Local stand-ins for the Hugging Face Space and Google's endpoint, with switchable failure modes. */
export async function startStubs() {
	const st = { bMode: 'ok' as BMode, gMode: 'ok' as GMode, gBlockFirst: 0, gDelay: 0, b: 0, g: 0, gBlockedPaths: new Set<string>(), gPaths: {} as Record<string, number>, gLines: [] as number[] };
	const backend = http.createServer((req, res) => {
		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', () => {
			st.b++;
			const { text, lang } = JSON.parse(body);
			if (st.bMode === 'asleep503') {
				res.statusCode = 503;
				return void res.end('<html>sleeping</html>');
			}
			if (st.bMode === 'asleep200') {
				res.setHeader('Content-Type', 'text/html');
				return void res.end('<html>starting</html>');
			}
			if (st.bMode === 'hang') {
				return;
			}
			res.setHeader('Content-Type', 'application/json');
			if (st.bMode === 'garbage') {
				return void res.end('{"nope":1}');
			}
			res.end(JSON.stringify({ translated: st.bMode === 'echo' ? text : `b|${lang}|${fake(text)}` }));
		});
	});
	const google = http.createServer((req, res) => {
		st.g++;
		const u = new URL(req.url!, 'http://x');
		const q = u.searchParams.get('q')!;
		st.gPaths[u.pathname] = (st.gPaths[u.pathname] ?? 0) + 1;
		st.gLines.push(q.split('\n').length);
		const chromeStyle = u.pathname.endsWith('/t');
		const reply = () => {
			if (st.gBlockFirst > 0) {
				st.gBlockFirst--;
				res.statusCode = 429;
				return void res.end('<html>Sorry</html>');
			}
			if (st.gBlockedPaths.has(u.pathname)) {
				res.statusCode = 429;
				return void res.end('<html>Sorry</html>');
			}
			if (st.gMode === 'block429') {
				res.statusCode = 429;
				return void res.end('<html>Sorry</html>');
			}
			if (st.gMode === 'html200') {
				res.setHeader('Content-Type', 'text/html');
				return void res.end('<html>Sorry</html>');
			}
			if (st.gMode === 'hang') {
				return;
			}
			res.setHeader('Content-Type', 'application/json');
			const tl = u.searchParams.get('tl');
			// every line is translated on its own and the line breaks survive, like the real service ('merge' drops them)
			const text = q.split('\n').map((l) => `g|${tl}|${fake(l)}`).join(st.gMode === 'merge' ? ' ' : '\n');
			res.end(JSON.stringify(chromeStyle ? [text] : [[[text, q]]]));
		};
		st.gDelay ? setTimeout(reply, st.gDelay) : reply();
	});
	await new Promise<void>((r) => backend.listen(0, '127.0.0.1', r));
	await new Promise<void>((r) => google.listen(0, '127.0.0.1', r));
	return {
		st,
		backendUrl: `http://127.0.0.1:${(backend.address() as { port: number }).port}`,
		googleUrl: `http://127.0.0.1:${(google.address() as { port: number }).port}/translate_a/single`,
		googleChromeUrl: `http://127.0.0.1:${(google.address() as { port: number }).port}/translate_a/t`,
		reset() {
			Object.assign(st, { bMode: 'ok', gMode: 'ok', gBlockFirst: 0, gDelay: 0, b: 0, g: 0, gBlockedPaths: new Set<string>(), gPaths: {}, gLines: [] });
		},
		close() {
			backend.closeAllConnections?.();
			google.closeAllConnections?.();
			backend.close();
			google.close();
		},
	};
}
export type Stubs = Awaited<ReturnType<typeof startStubs>>;

export interface ServiceOpts {
	ai?: LlmClient[];
	aiWanted?: boolean;
	context?: ContextFile;
	provider?: 'auto' | 'backend' | 'google';
	budgetMs?: number;
	reviewPass?: boolean;
	sourceLocale?: string;
	log?: (m: string) => void;
	health?: ProviderHealth;
}

/** A TranslationService wired to the stubs: optional AI clients first, machine translation as the fallback. */
export function makeService(stubs: Stubs, o: ServiceOpts = {}) {
	const log = o.log ?? (() => undefined);
	const context = o.context ?? EMPTY_CONTEXT;
	const health = o.health ?? new ProviderHealth();
	const ai = o.ai?.length
		? new AiEngine({ clients: o.ai, context, sourceLocale: o.sourceLocale ?? 'en', reviewPass: o.reviewPass ?? false, log, timing: { rateBackoffMs: 1, maxRateRetries: 2, maxTransientRetries: 1 } })
		: undefined;
	return new TranslationService({
		ai,
		aiWanted: o.aiWanted ?? !!ai,
		context,
		sourceLocale: o.sourceLocale ?? 'en',
		log,
		classic: () =>
			new Translator(
				{
					backendUrl: stubs.backendUrl,
					googleUrl: stubs.googleUrl,
					backendTimeoutMs: 800,
					provider: o.provider ?? 'google',
					expectedStrings: 1,
					budgetMs: o.budgetMs ?? 20000,
					timing: FAST,
					log,
				},
				o.sourceLocale ?? 'en',
				health,
			),
	});
}
