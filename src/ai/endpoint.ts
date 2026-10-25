import type { ContextFile } from '../context';

/** What the user picks in the settings. "auto" = nothing of their own: Copilot, the built-in default and the free fallbacks. */
export type ProviderId = 'auto' | 'gemini' | 'groq' | 'ollama' | 'custom';

export const OLLAMA_ADDRESS = 'http://127.0.0.1:11434';

interface Preset {
	label: string;
	/** OpenAI-compatible base URL */
	endpoint: string;
	/** models that share the key; each has its own allowance, so the next one is used when one is limited */
	models: string[];
	keyUrl: string;
}

export const PRESETS: Record<'gemini' | 'groq', Preset> = {
	gemini: {
		label: 'Google Gemini',
		endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai',
		// fastest dependable first: 3.8-flash is the newest but was taking 100+ seconds per batch, so it is the last resort
		models: ['gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.8-flash'],
		keyUrl: 'https://aistudio.google.com/apikey',
	},
	groq: {
		label: 'Groq',
		endpoint: 'https://api.groq.com/openai/v1',
		models: ['openai/gpt-oss-120b'],
		keyUrl: 'https://console.groq.com/keys',
	},
};

export interface ChosenProvider {
	/** which key slot it uses */
	provider: 'gemini' | 'groq' | 'custom';
	label: string;
	endpoint: string;
	models: string[];
	/** where the choice came from, for the log */
	from: 'settings' | 'context file';
}

/**
 * Gemini models think before they answer by default, which makes a translation batch take many seconds. "low" was measured to
 * give the same results on a reference set (Spanish, Tamil) several times faster, and uses fewer tokens of the free allowance.
 * Only sent to Google's endpoint: other servers may not know the field.
 */
export function reasoningFor(endpoint: string): string | undefined {
	try {
		return new URL(endpoint).host === 'generativelanguage.googleapis.com' ? 'low' : undefined;
	} catch {
		return undefined;
	}
}

const list = (s: string) => s.split(',').map((m) => m.trim()).filter(Boolean);

/** Where the API key of a provider is kept (VS Code secret storage, this machine only). */
export const keySlot = (provider: string) => `i18nSync.aiKey.${provider}`;

/**
 * The hosted provider to use after Copilot: the one picked in the settings, or, for "custom" and "automatic", the endpoint a
 * team shares in the context file. Only the endpoint and model are shared that way; the API key always stays in each person's
 * secret storage. (Ollama runs locally and is handled where its client is built.)
 */
export function resolveProvider(ai: { provider: string; endpoint: string; model: string }, context: ContextFile): ChosenProvider | undefined {
	if (ai.provider === 'gemini' || ai.provider === 'groq') {
		const p = PRESETS[ai.provider];
		return { provider: ai.provider, label: p.label, endpoint: p.endpoint, models: list(ai.model).length ? list(ai.model) : p.models, from: 'settings' };
	}
	const shared = context.ai;
	if (ai.provider === 'custom' && ai.endpoint && ai.model) {
		return { provider: 'custom', label: 'Custom endpoint', endpoint: ai.endpoint, models: list(ai.model), from: 'settings' };
	}
	// own fields left empty: use what the team shares; a half-filled own endpoint is never silently replaced
	if ((ai.provider === 'custom' || ai.provider === 'auto') && !ai.endpoint && !ai.model && shared?.endpoint && shared.model) {
		return { provider: 'custom', label: 'Custom endpoint', endpoint: shared.endpoint, models: list(shared.model), from: 'context file' };
	}
	return undefined;
}
