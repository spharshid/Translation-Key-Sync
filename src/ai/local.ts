import { LlmClient, OpenAiCompatClient } from './clients';
import { OLLAMA_ADDRESS } from './endpoint';

/** Models tried first, best general translators first; embedding models are never chosen. */
const PREFER = ['qwen2.5', 'qwen3', 'llama3.3', 'llama3.1', 'gemma3', 'gemma2', 'mistral', 'phi4', 'phi3'];

/** The chat models installed in an Ollama server (embedding models left out), best translators first; empty when it is not running. */
export async function listOllamaModels(baseUrl = OLLAMA_ADDRESS): Promise<string[]> {
	try {
		const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(800) });
		if (!res.ok) {
			return [];
		}
		const names: string[] = ((await res.json()) as { models?: { name: string }[] }).models?.map((m) => m.name) ?? [];
		const rank = (n: string) => {
			const i = PREFER.findIndex((p) => n.toLowerCase().includes(p));
			return i < 0 ? PREFER.length : i;
		};
		return names.filter((n) => !/embed|bge|nomic|minilm|rerank/i.test(n)).sort((a, b) => rank(a) - rank(b));
	} catch {
		return [];
	}
}

/** A client for one model running locally under Ollama (free, offline, no key). Small local models can be weaker in some languages. */
export function ollamaClient(model: string, baseUrl = OLLAMA_ADDRESS): LlmClient {
	return new OpenAiCompatClient({ baseUrl: `${baseUrl}/v1`, model, timeoutMs: 300_000, maxPromptChars: 5000, label: `${model} (Ollama)` });
}

/** The best model that Ollama has installed, or undefined when the server is not up or has none. */
export async function detectOllama(baseUrl = OLLAMA_ADDRESS): Promise<LlmClient | undefined> {
	const [model] = await listOllamaModels(baseUrl);
	return model ? ollamaClient(model, baseUrl) : undefined;
}
