import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AiEngine } from './ai/engine';
import { LlmClient, OpenAiCompatClient } from './ai/clients';
import { FreeEndpointClient } from './ai/free';
import { PooledClient } from './ai/pool';
import { keySlot, OLLAMA_ADDRESS, reasoningFor, resolveProvider } from './ai/endpoint';
import { detectOllama, ollamaClient } from './ai/local';
import { createCopilotClient } from './ai/vscodeLm';
import { ContextFile, defaultContextPath, EMPTY_CONTEXT, loadContext } from './context';
import { buildMemory } from './memory';
import { parseDestinations, localesDirOf } from './destinations';
import { resolveUserPath } from './paths';
import type { PendingStore } from './pending';
import { dottedPath } from './ai/refs';
import { SyncConfig } from './syncCommit';
import { profileConfig, profileUnlocked } from './profile';
import { git } from './git';
import { TranslationService } from './translation';
import { ProviderHealth, Translator } from './translator';

const PROFILE_FLAG = 'profileEnabled';

export function readSettings() {
	const c = vscode.workspace.getConfiguration('i18nSync');
	const allDestinations = parseDestinations(c.get<unknown>('destinations', []), resolveUserPath);
	/** the ticked destinations: what the on-commit sync uses, and what the Sync Locales prompt offers */
	const cfg: SyncConfig = {
		sourceDir: resolveUserPath(c.get<string>('source', '')),
		destinations: allDestinations.filter((d) => d.enabled),
		locales: c.get<string[]>('locales', []),
		sourceLocale: c.get<string>('sourceLocale', 'en'),
	};
	return {
		cfg,
		allDestinations,
		/** the first "translate" destination: where the locale sub-folders live (context file, memory, quality check) */
		localesDir: localesDirOf(allDestinations),
		configured: !!cfg.sourceDir && cfg.destinations.length > 0 && (!cfg.destinations.some((d) => d.mode === 'translate') || cfg.locales.length > 0),
		enabled: c.get<boolean>('enabled', true),
		onlyOwnCommits: c.get<boolean>('onlyOwnCommits', true),
		askDestinations: c.get<boolean>('askDestinations', true),
		contextFile: resolveUserPath(c.get<string>('contextFile', '')),
		useMemory: c.get<boolean>('memory.enabled', true),
		ai: {
			enabled: c.get<boolean>('ai.enabled', true),
			copilotModel: c.get<string>('ai.copilotModel', 'included'),
			reviewPass: c.get<boolean>('ai.reviewPass', true),
			endpoint: c.get<string>('ai.endpoint', ''),
			model: c.get<string>('ai.model', ''),
			provider: c.get<'auto' | 'gemini' | 'groq' | 'ollama' | 'custom'>('ai.provider', 'auto'),
			useCopilot: c.get<boolean>('ai.useCopilot', true),
			allowFree: c.get<boolean>('ai.allowFreeFallbacks', true),
		},
		backendUrl: c.get<string>('backendUrl', ''),
		backendTimeoutMs: c.get<number>('backendTimeoutSeconds', 60) * 1000,
		provider: c.get<'auto' | 'backend' | 'google'>('provider', 'auto'),
		googleUrl: c.get<string>('googleUrl', ''),
		budgetMs: c.get<number>('maxWaitMinutes', 5) * 60_000,
	};
}
export type Settings = ReturnType<typeof readSettings>;

/** The context file the user picked, or the one next to the locale folders if it exists. */
export function contextPath(s: Settings): string {
	if (s.contextFile) {
		return s.contextFile;
	}
	const fallback = s.localesDir ? defaultContextPath(s.localesDir) : '';
	return fallback && fs.existsSync(fallback) ? fallback : '';
}

export class Runtime {
	/** shared by every run so a Space we already woke up (or a Google that is rate limiting us) is remembered */
	readonly health = new ProviderHealth();

	constructor(
		private readonly secrets: vscode.SecretStorage,
		private readonly log: (m: string) => void,
		private readonly pending: () => PendingStore | undefined = () => undefined,
		private readonly state?: vscode.Memento,
	) {}

	/** The model of the provider the user picked, if it can be used right now (key saved, Ollama running). */
	private async providerClient(s: Settings): Promise<{ client: LlmClient; label: string } | undefined> {
		if (s.ai.provider === 'ollama') {
			const address = s.ai.endpoint || OLLAMA_ADDRESS;
			const client = s.ai.model ? ollamaClient(s.ai.model, address) : await detectOllama(address);
			if (!client) {
				this.log(`Ollama not used: no server with a model found at ${address}`);
			}
			return client && { client, label: client.label };
		}
		const chosen = resolveProvider(s.ai, await this.loadContext(s));
		if (!chosen) {
			return undefined;
		}
		const apiKey = (await this.secrets.get(keySlot(chosen.provider))) || undefined;
		if (!apiKey && chosen.provider !== 'custom') {
			this.log(`${chosen.label} not used: no API key saved on this machine`);
			return undefined;
		}
		this.log(`${chosen.label} (from ${chosen.from}): ${chosen.models.join(', ')} @ ${chosen.endpoint}${apiKey ? '' : ' (no API key set on this machine)'}`);
		// several models share one key but have separate allowances: rotate through them
		const reasoningEffort = reasoningFor(chosen.endpoint);
		const client = chosen.models.length > 1 ? new PooledClient({ baseUrl: chosen.endpoint, models: chosen.models, apiKey, reasoningEffort, log: this.log }) : new OpenAiCompatClient({ baseUrl: chosen.endpoint, model: chosen.models[0], apiKey, reasoningEffort });
		return { client, label: chosen.label };
	}

	/** One line for the settings page: what translates right now, in the fixed order. */
	async usingNow(s: Settings): Promise<string> {
		if (!s.ai.enabled) {
			return 'machine translation only (AI is switched off)';
		}
		if (s.ai.useCopilot) {
			const copilot = await createCopilotClient(s.ai.copilotModel);
			if (copilot.client) {
				return 'GitHub Copilot';
			}
		}
		const own = await this.providerClient(s);
		if (own) {
			return own.label;
		}
		if (await this.profileClient(s)) {
			return 'the built-in default';
		}
		return s.ai.allowFree ? 'the free services (free AI, then Google)' : 'Google machine translation only';
	}

	async loadContext(s: Settings): Promise<ContextFile> {
		const file = contextPath(s);
		if (!file) {
			return EMPTY_CONTEXT;
		}
		const { context, problems } = await loadContext(file);
		for (const p of problems) {
			this.log(`context file: ${p}`);
		}
		this.log(`context file ${file}: ${context.glossary.length} glossary term(s), ${context.doNotTranslate.length} kept name(s)`);
		return context;
	}

	/** Approved translations that already exist in the destination, minus entries that are themselves unconfirmed. */
	async loadMemory(s: Settings) {
		const exclude = new Set<string>();
		for (const e of (await this.pending()?.all()) ?? []) {
			exclude.add(`${path.resolve(e.file)}::${dottedPath(e.path)}`);
		}
		return buildMemory(s.localesDir, s.cfg.locales, s.cfg.sourceLocale, exclude);
	}

	/** Facts about this person's setup that a profile may look at. */
	private async profileContext(s: Settings) {
		const run = async (cwd: string, args: string[]) => {
			try {
				return (await git('git', cwd, args)).trim();
			} catch {
				return '';
			}
		};
		const folders = [...s.allDestinations.map((d) => d.path), s.cfg.sourceDir].filter(Boolean);
		const remotes = new Set<string>();
		for (const f of folders) {
			for (const line of (await run(f, ['remote', '-v'])).split('\n')) {
				const url = line.split(/\s+/)[1];
				if (url) {
					remotes.add(url);
				}
			}
		}
		return { remotes: [...remotes], folders };
	}

	private profileOn: boolean | undefined;
	private profileCheck = 0;

	/**
	 * Decide whether this build's endpoint profile is for this setup. Runs when the settings are saved, not on every sync.
	 * It only looks at the folders and their git remotes, so it does not matter in which order the settings were filled in,
	 * and when checks overlap the newest one decides.
	 */
	async refreshProfile(s: Settings): Promise<void> {
		const mine = ++this.profileCheck;
		const ctx = await this.profileContext(s);
		const on = ctx.folders.length > 0 && profileUnlocked(ctx);
		if (mine !== this.profileCheck) {
			return;
		}
		this.profileOn = on;
		await this.state?.update(PROFILE_FLAG, on);
	}

	/** An endpoint profile provided by this build, if any (the stub in a normal build provides none). */
	private async profileClient(s: Settings): Promise<LlmClient | undefined> {
		this.profileOn ??= this.state?.get<boolean>(PROFILE_FLAG);
		if (this.profileOn === undefined) {
			// settings saved before this was recorded: decide once
			await this.refreshProfile(s);
		}
		const p = this.profileOn ? profileConfig() : undefined;
		if (!p) {
			return undefined;
		}
		return p.models.length > 1
			? new PooledClient({ baseUrl: p.endpoint, models: p.models, apiKey: p.key, reasoningEffort: reasoningFor(p.endpoint), log: this.log })
			: new OpenAiCompatClient({ baseUrl: p.endpoint, model: p.models[0], apiKey: p.key, reasoningEffort: reasoningFor(p.endpoint) });
	}

	/**
	 * Language models to try, in a fixed order (empty when none is available): GitHub Copilot, the provider the user picked,
	 * the built-in default of this build (if any), then the free AI service.
	 */
	async aiClients(s: Settings): Promise<LlmClient[]> {
		if (!s.ai.enabled) {
			return [];
		}
		const clients: LlmClient[] = [];
		if (s.ai.useCopilot) {
			const copilot = await createCopilotClient(s.ai.copilotModel);
			if (copilot.client) {
				clients.push(copilot.client);
			} else {
				this.log(`Copilot not used: ${copilot.reason}`);
			}
		}
		const own = await this.providerClient(s);
		if (own) {
			clients.push(own.client);
		}
		const profile = await this.profileClient(s);
		if (profile) {
			clients.push(profile);
		}
		if (s.ai.allowFree) {
			clients.push(new FreeEndpointClient());
		}
		for (const c of clients) {
			this.log(`AI model available: ${c.label}`);
		}
		return clients;
	}

	/**
	 * Everything needed to translate: the AI engine (when a model is available), the machine-translation fallback and
	 * the context file. `expectedStrings` sizes the time budget.
	 */
	async buildService(s: Settings, expectedStrings: number, onTranslated?: () => void, extraClients?: LlmClient[], useMemory = true): Promise<TranslationService> {
		const t0 = Date.now();
		// time spent actively translating is work, not waiting: allow ~2 s per string on top of the wait budget
		const clients0 = extraClients ?? (await this.aiClients(s));
		// the free service is paced (2 requests/min per model) and its best models take 30-90 s per request: give it room
		const slowest = clients0.some((c) => c instanceof FreeEndpointClient) ? 10 * 60_000 : 0;
		const budget = Math.min(Math.max(s.budgetMs + expectedStrings * 2000, slowest), 30 * 60_000);
		const context = await this.loadContext(s);
		const clients = clients0;
		// the free service is shared by everyone on the same network and limited to 2 requests/min per model: do not spend
		// requests on the proofreading pass there (the validators and the corrective retry still run)
		const onlyFree = clients.length > 0 && clients.every((c) => c instanceof FreeEndpointClient);
		const ai = clients.length
			? new AiEngine({
					clients,
					context,
					sourceLocale: s.cfg.sourceLocale,
					reviewPass: s.ai.reviewPass && !onlyFree,
					log: this.log,
					stop: () => Date.now() - t0 > budget,
				})
			: undefined;
		if (!ai && s.ai.enabled) {
			this.log('no AI model available: using machine translation (Google / Hugging Face), which is less accurate');
		}
		const classic = () =>
			new Translator(
				{
					backendUrl: s.backendUrl,
					googleUrl: s.googleUrl || undefined,
					backendTimeoutMs: s.backendTimeoutMs,
					provider: s.provider,
					expectedStrings,
					budgetMs: s.budgetMs,
					log: this.log,
				},
				s.cfg.sourceLocale,
				this.health,
			);
		const memory = useMemory && s.useMemory && s.localesDir ? await this.loadMemory(s) : undefined;
		return new TranslationService({ ai, aiWanted: s.ai.enabled, memory, classic, context, sourceLocale: s.cfg.sourceLocale, log: this.log, onTranslated });
	}
}
