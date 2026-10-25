import { Cancelled } from '../cancel';
import * as vscode from 'vscode';
import { LlmClient, LlmError } from './clients';

/**
 * Model families tried first for each policy (matched as case-insensitive substrings of the model's id, family or name).
 * "included" lists models GitHub has offered without charging premium requests on paid Copilot plans; that list can
 * change, so "best" and an explicit model name are available too.
 */
const PREFERENCE: Record<string, string[]> = {
	included: ['gpt-4.1', 'gpt-5-mini', 'gpt-4o'],
	best: ['claude-sonnet', 'gpt-5', 'claude', 'gpt-4.1', 'gpt-4o'],
};

const haystack = (m: vscode.LanguageModelChat) => `${m.id} ${m.family} ${m.name}`.toLowerCase();

/** Pick one of the available Copilot models: by policy ("included" | "best") or by a model name fragment. */
function chooseModel(models: vscode.LanguageModelChat[], policy: string): vscode.LanguageModelChat | undefined {
	if (!models.length) {
		return undefined;
	}
	const wanted = policy.trim().toLowerCase();
	if (wanted && !PREFERENCE[wanted]) {
		const exact = models.find((m) => haystack(m).includes(wanted));
		if (exact) {
			return exact;
		}
	}
	const prefs = PREFERENCE[PREFERENCE[wanted] ? wanted : 'included'];
	const rank = (m: vscode.LanguageModelChat) => {
		const i = prefs.findIndex((p) => haystack(m).includes(p));
		return i < 0 ? prefs.length : i;
	};
	return [...models].sort((a, b) => rank(a) - rank(b))[0];
}

class CopilotClient implements LlmClient {
	readonly label: string;
	readonly maxPromptChars: number;

	constructor(private readonly model: vscode.LanguageModelChat) {
		this.label = `Copilot ${model.name || model.family}`;
		// ~3 characters per token is conservative for non-Latin scripts; leave room for the answer
		this.maxPromptChars = Math.max(4000, Math.floor(model.maxInputTokens * 3 * 0.5));
	}

	async complete(prompt: string, opts: { signal?: AbortSignal } = {}): Promise<string> {
		const cts = new vscode.CancellationTokenSource();
		opts.signal?.addEventListener('abort', () => cts.cancel());
		try {
			const res = await this.model.sendRequest(
				[vscode.LanguageModelChatMessage.User(prompt)],
				{ justification: 'Translate changed UI strings into the configured languages.' },
				cts.token,
			);
			let text = '';
			for await (const fragment of res.text) {
				text += fragment;
			}
			if (!text.trim()) {
				throw new LlmError('empty answer', 'transient');
			}
			return text;
		} catch (e) {
			if (opts.signal?.aborted) {
				throw new Cancelled();
			}
			if (e instanceof LlmError) {
				throw e;
			}
			if (e instanceof vscode.LanguageModelError) {
				// NoPermissions (consent not given), Blocked (quota used up) and NotFound cannot be fixed by retrying
				if (['NoPermissions', 'Blocked', 'NotFound'].includes(e.code)) {
					throw new LlmError(`${e.code}: ${e.message}`, 'unavailable');
				}
				if (/rate|limit|429|too many/i.test(e.message)) {
					throw new LlmError(e.message, 'rate');
				}
				throw new LlmError(e.message, 'transient');
			}
			throw new LlmError((e as Error).message, 'transient');
		} finally {
			cts.dispose();
		}
	}
}

export async function createCopilotClient(policy: string): Promise<{ client?: LlmClient; reason?: string }> {
	if (!vscode.lm?.selectChatModels) {
		return { reason: 'this version of VS Code has no language model API (update VS Code)' };
	}
	let models: vscode.LanguageModelChat[];
	try {
		models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
	} catch (e) {
		return { reason: `could not list Copilot models: ${(e as Error).message}` };
	}
	const model = chooseModel(models, policy);
	if (!model) {
		return { reason: 'no Copilot model is available (is GitHub Copilot installed and signed in?)' };
	}
	return { client: new CopilotClient(model) };
}
