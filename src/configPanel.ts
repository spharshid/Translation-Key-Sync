import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { OLLAMA_ADDRESS, PRESETS } from './ai/endpoint';
import { Destination, parseDestinations } from './destinations';
import { resolveUserPath } from './paths';

const SECTION = 'i18nSync';

interface Form {
	/** the folder with the base-language files that strings are synced from */
	source: string;
	destinations: Destination[];
	locales: string[];
	sourceLocale: string;
	onlyOwnCommits: boolean;
	enabled: boolean;
	askDestinations: boolean;
	contextFile: string;
	aiProvider: string;
	aiEndpoint: string;
	aiModel: string;
	aiUseCopilot: boolean;
	aiReviewPass: boolean;
	aiAllowFree: boolean;
}

/** what the page sends: the form plus a key typed in this session (it is stored in secret storage, never in the settings) */
type Submitted = Form & { aiKey?: string };

/** form field -> setting name */
const KEYS: Record<keyof Form, string> = {
	source: 'source',
	destinations: 'destinations',
	locales: 'locales',
	sourceLocale: 'sourceLocale',
	onlyOwnCommits: 'onlyOwnCommits',
	enabled: 'enabled',
	askDestinations: 'askDestinations',
	contextFile: 'contextFile',
	aiProvider: 'ai.provider',
	aiEndpoint: 'ai.endpoint',
	aiModel: 'ai.model',
	aiUseCopilot: 'ai.useCopilot',
	aiReviewPass: 'ai.reviewPass',
	aiAllowFree: 'ai.allowFreeFallbacks',
};

/** What the settings page needs from the extension. */
export interface ConfigDeps {
	/** what translates right now, for the "Using now" line */
	using(): Promise<string>;
	/** which providers already have a key on this machine (the keys themselves never reach the page) */
	keysSaved(): Promise<Record<string, boolean>>;
	storeKey(provider: string, key: string): Promise<void>;
	ollamaModels(address: string): Promise<string[]>;
}

const isDir = (p: string) => {
	try {
		return fs.statSync(resolveUserPath(p)).isDirectory();
	} catch {
		return false;
	}
};
const isFile = (p: string) => {
	try {
		return fs.statSync(p).isFile();
	} catch {
		return false;
	}
};

function load(): Form {
	const c = vscode.workspace.getConfiguration(SECTION);
	const f = {} as Record<string, unknown>;
	const defaults: Record<keyof Form, unknown> = {
		source: '',
		destinations: [],
		locales: [],
		sourceLocale: 'en',
		onlyOwnCommits: true,
		enabled: true,
		askDestinations: true,
		contextFile: '',
		aiProvider: 'auto',
		aiEndpoint: '',
		aiModel: '',
		aiUseCopilot: true,
		aiReviewPass: true,
		aiAllowFree: true,
	};
	for (const [field, key] of Object.entries(KEYS)) {
		f[field] = c.get(key, defaults[field as keyof Form]);
	}
	f.destinations = parseDestinations(f.destinations); // as typed: `~/` is only expanded when the settings are used
	return f as unknown as Form;
}

/** Problems that would stop the sync from working; empty = good to save. */
function validate(f: Form): string[] {
	const errs: string[] = [];
	if (!f.source) {
		errs.push('Choose the source folder (the base-language files strings are synced from).');
	} else if (!isDir(f.source)) {
		errs.push('The source folder does not exist.');
	}
	if (!f.destinations.length) {
		errs.push('Add at least one destination.');
	}
	const seen = new Set<string>();
	for (const d of f.destinations) {
		const p = resolveUserPath(d.path);
		if (!p) {
			errs.push('A destination has no folder. Choose one or remove the row.');
			continue;
		}
		if (!isDir(p)) {
			errs.push(`The destination folder does not exist: ${d.path}`);
		}
		if (seen.has(p.toLowerCase())) {
			errs.push(`The destination is listed twice: ${d.path}`);
		}
		seen.add(p.toLowerCase());
		if (f.source && p.toLowerCase() === resolveUserPath(f.source).toLowerCase()) {
			errs.push(`A destination is the same folder as the source: ${d.path}`);
		}
	}
	if (f.destinations.some((d) => d.mode === 'translate') && !f.locales.length) {
		errs.push('Add at least one language (needed by destinations that translate).');
	}
	if (!f.sourceLocale.trim()) {
		errs.push('The base language is required.');
	}
	if (f.contextFile && !isFile(f.contextFile)) {
		errs.push('The context file does not exist. Clear the field, or use "Create from template".');
	}
	if (f.aiProvider === 'custom') {
		const url = f.aiEndpoint.toLowerCase();
		if (!url.startsWith('http://') && !url.startsWith('https://')) {
			errs.push('The custom AI provider needs a base URL that starts with http:// or https://.');
		}
		if (!f.aiModel) {
			errs.push('The custom AI provider needs a model name.');
		}
	}
	return errs;
}

let panel: vscode.WebviewPanel | undefined;

export function openConfigPanel(ctx: vscode.ExtensionContext, onSaved: () => void, deps: ConfigDeps) {
	if (panel) {
		panel.reveal();
		return;
	}
	panel = vscode.window.createWebviewPanel('i18nSyncConfig', 'i18n AI Translate & Sync: Settings', vscode.ViewColumn.Active, {
		enableScripts: true,
	});
	panel.onDidDispose(() => (panel = undefined), null, ctx.subscriptions);
	const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
	void deps.keysSaved().then((keys) => {
		if (panel) {
			panel.webview.html = html(nonce, panel.webview.cspSource, load(), keys);
		}
	});

	panel.webview.onDidReceiveMessage(
		async (m) => {
			if (m.type === 'browse') {
				const pick = await vscode.window.showOpenDialog({
					canSelectFolders: !m.file,
					canSelectFiles: !!m.file,
					canSelectMany: false,
					filters: m.file ? { JSON: ['json'] } : undefined,
					defaultUri: m.current && (isDir(m.current) || isFile(m.current)) ? vscode.Uri.file(resolveUserPath(m.current)) : undefined,
					openLabel: m.file ? 'Select file' : 'Select folder',
				});
				if (pick?.[0]) {
					panel?.webview.postMessage({ type: 'picked', field: m.field, index: m.index, value: pick[0].fsPath });
				}
			} else if (m.type === 'detect') {
				// every sub-folder of a translate destination is a language
				const dir = resolveUserPath(String(m.dir ?? ''));
				const found = isDir(dir) ? fs.readdirSync(dir).filter((d) => isDir(path.join(dir, d)) && !d.startsWith('.')) : [];
				panel?.webview.postMessage({ type: 'detected', locales: found });
			} else if (m.type === 'using') {
				panel?.webview.postMessage({ type: 'using', text: await deps.using() });
			} else if (m.type === 'ollamaModels') {
				panel?.webview.postMessage({ type: 'ollamaModels', models: await deps.ollamaModels(String(m.address || '') || OLLAMA_ADDRESS) });
			} else if (m.type === 'open') {
				const allowed = [PRESETS.gemini.keyUrl, PRESETS.groq.keyUrl];
				if (allowed.includes(String(m.url))) {
					void vscode.env.openExternal(vscode.Uri.parse(String(m.url)));
				}
			} else if (m.type === 'run') {
				// buttons that run a command; some of them change a setting, so refresh the field afterwards
				await vscode.commands.executeCommand(String(m.command));
				panel?.webview.postMessage({ type: 'picked', field: 'contextFile', value: vscode.workspace.getConfiguration(SECTION).get('contextFile', '') });
			} else if (m.type === 'save') {
				const form: Submitted = m.form;
				const errs = validate(form);
				if (errs.length) {
					panel?.webview.postMessage({ type: 'errors', errors: errs });
					return;
				}
				const c = vscode.workspace.getConfiguration(SECTION);
				const T = vscode.ConfigurationTarget.Global; // paths are per machine, not per project
				for (const [field, key] of Object.entries(KEYS)) {
					await c.update(key, form[field as keyof Form], T);
				}
				const keyTyped = (form.aiKey ?? '').trim();
				const needsKey = form.aiProvider === 'gemini' || form.aiProvider === 'groq';
				if (keyTyped && (needsKey || form.aiProvider === 'custom')) {
					await deps.storeKey(form.aiProvider, keyTyped);
				}
				const warn: string[] = [];
				for (const d of form.destinations.filter((x) => x.mode === 'translate')) {
					const missing = form.locales.filter((l) => !isDir(path.join(d.path, l)));
					if (missing.length) {
						warn.push(`No folder yet for: ${missing.join(', ')} in ${d.path} (it will be created on first sync).`);
					}
				}
				if (!form.destinations.some((d) => d.enabled)) {
					warn.push('No destination is ticked, so nothing will be synced.');
				}
				const hasRepo = (vscode.workspace.workspaceFolders ?? []).length > 0;
				if (form.enabled && !hasRepo) {
					warn.push("Open the source folder's repo in VS Code so its commits can be detected.");
				}
				if (needsKey && !keyTyped && !(await deps.keysSaved())[form.aiProvider]) {
					warn.push(`${PRESETS[form.aiProvider as 'gemini' | 'groq'].label} needs an API key; until one is saved it is skipped.`);
				}
				panel?.webview.postMessage({ type: 'saved', warnings: warn });
				onSaved();
			}
		},
		undefined,
		ctx.subscriptions,
	);
}

export function isConfigured(): boolean {
	return validate(load()).length === 0;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const checked = (b: boolean) => (b ? 'checked' : '');
const sel = (a: string, b: string) => (a === b ? 'selected' : '');

function html(nonce: string, csp: string, f: Form, keysSaved: Record<string, boolean>): string {
	const presetModels = { gemini: PRESETS.gemini.models.join(', '), groq: PRESETS.groq.models.join(', ') };
	return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
	body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px 24px 48px; max-width: 760px; }
	h1 { font-size: 1.4em; font-weight: 600; margin: 0 0 4px; }
	h2 { font-size: 1.1em; font-weight: 600; margin: 30px 0 4px; padding-bottom: 4px; border-bottom: 1px solid var(--vscode-panel-border, #8884); }
	p.sub { color: var(--vscode-descriptionForeground); margin: 0 0 8px; }
	label.t { display: block; font-weight: 600; margin: 16px 0 2px; }
	.hint { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin: 2px 0 6px; }
	.row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
	input[type=text], input[type=password], select { flex: 1; min-width: 0; padding: 4px 6px; color: var(--vscode-input-foreground);
		background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); }
	input[type=text]:focus, input[type=password]:focus, select:focus { outline: 1px solid var(--vscode-focusBorder); }
	button { padding: 4px 12px; color: var(--vscode-button-foreground); background: var(--vscode-button-background);
		border: 0; cursor: pointer; }
	button:hover { background: var(--vscode-button-hoverBackground); }
	button.sec { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
	.chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
	.chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 4px 2px 8px; border-radius: 10px;
		color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); }
	.chip button { padding: 0 4px; background: transparent; color: inherit; }
	.check { margin: 8px 0 2px; display: flex; gap: 6px; align-items: flex-start; }
	.check + .hint { margin-left: 24px; }
	details { margin-top: 14px; }
	summary { cursor: pointer; font-weight: 600; }
	.dest { display: flex; gap: 6px; align-items: center; margin: 6px 0; }
	.dest select { flex: none; width: 190px; }
	.dest button.x { padding: 2px 8px; }
	.using { display: flex; gap: 10px; align-items: center; margin: 14px 0 0; padding: 8px 10px; background: var(--vscode-textBlockQuote-background, #7f7f7f1a); border-radius: 4px; }
	.using span { flex: 1; }
	#msg { margin-top: 16px; padding: 8px 10px; display: none; border-left: 3px solid; }
	#msg.err { display: block; border-color: var(--vscode-errorForeground); }
	#msg.ok { display: block; border-color: var(--vscode-testing-iconPassed, #3a3); }
	#msg ul { margin: 4px 0 0 18px; padding: 0; }
	.actions { margin-top: 28px; }
</style></head>
<body>
<h1>i18n AI Translate &amp; Sync</h1>
<p class="sub">Write strings once, in a base language. Pick the folder they come from and tick the folders each change should go to.</p>

<h2>1. Source</h2>
<label class="t" for="source">Source folder</label>
<div class="hint">The base-language files strings are synced from: a fallback copy in an application repo (<code>C:\\AppRepo\\locales\\en</code>) or the base-language folder of your translation repo (<code>C:\\TranslationRepo\\locales\\en</code>). Use <code>~/…</code> for your home folder on macOS/Linux.</div>
<div class="row"><input type="text" id="source" value="${esc(f.source)}"><button class="sec" data-browse="source">Browse…</button></div>

<label class="t" for="sourceLocale">Base language</label>
<div class="hint">The language the source is written in, e.g. <code>en</code>. It is never translated; the other languages are translated from it.</div>
<div class="row"><input type="text" id="sourceLocale" value="${esc(f.sourceLocale)}" style="max-width:120px;flex:none"></div>

<div class="check"><input type="checkbox" id="enabled" ${checked(f.enabled)}><label for="enabled">Sync automatically after each commit in the source folder's repo</label></div>
<div class="hint">Goes to the ticked destinations below, without asking. Turn it off to sync only with the buttons.</div>
<div class="check"><input type="checkbox" id="onlyOwnCommits" ${checked(f.onlyOwnCommits)}><label for="onlyOwnCommits">Only commits authored by me (ignores pulled commits)</label></div>

<h2>2. Destinations</h2>
<div class="hint">Tick the folders to include when syncing. <b>Translate</b>: a folder with one sub-folder per language (<code>en</code>, <code>es</code>, <code>fr</code>…), e.g. your translation repo's <code>locales</code>. <b>Copy</b>: the base language is copied as it is, e.g. a fallback copy in an application repo.</div>
<div id="dests"></div>
<div class="row" style="margin-top:6px"><button class="sec" id="addDest">+ Add destination</button></div>

<label class="t">Languages</label>
<div class="hint">Used by the destinations that translate.</div>
<div class="chips" id="chips"></div>
<div class="row">
	<input type="text" id="newLocale" placeholder="e.g. fr">
	<button class="sec" id="add">Add</button>
	<button class="sec" id="detect">Detect from the first translate destination</button>
</div>

<div class="check" style="margin-top:16px"><input type="checkbox" id="askDestinations" ${checked(f.askDestinations)}><label for="askDestinations">Ask which destinations to use each time I press Sync Locales (when more than one is ticked)</label></div>
<div class="hint">So one batch can go to one repo and the next to both, without coming back here.</div>
<div class="row" style="margin-top:8px">
	<button class="sec" data-run="i18nSync.syncDestination">Sync Locales now</button>
	<button class="sec" data-run="i18nSync.syncLastCommit">Sync last commit now</button>
	<button class="sec" data-run="i18nSync.showStatus">Show translation status</button>
</div>

<h2>3. Translation</h2>
<label class="t" for="aiProvider">AI provider</label>
<div class="hint">GitHub Copilot is used first whenever VS Code has it. Choose a provider only if you want your own as the next step.</div>
<div class="row"><select id="aiProvider">
	<option value="auto" ${sel(f.aiProvider, 'auto')}>Automatic</option>
	<option value="gemini" ${sel(f.aiProvider, 'gemini')}>Google Gemini (free key)</option>
	<option value="groq" ${sel(f.aiProvider, 'groq')}>Groq (free key)</option>
	<option value="ollama" ${sel(f.aiProvider, 'ollama')}>Ollama (on this computer)</option>
	<option value="custom" ${sel(f.aiProvider, 'custom')}>Custom (OpenAI-compatible)</option>
</select></div>

<div class="prov" data-for="gemini groq custom">
	<label class="t" for="aiKey">API key</label>
	<div class="row"><input type="password" id="aiKey" autocomplete="off" spellcheck="false"></div>
	<div class="hint" id="keyHint"></div>
</div>
<div class="row prov" data-for="gemini"><button class="sec" data-open="${PRESETS.gemini.keyUrl}">Get a free Gemini key</button></div>
<div class="row prov" data-for="groq"><button class="sec" data-open="${PRESETS.groq.keyUrl}">Get a free Groq key</button></div>
<div class="prov" data-for="ollama">
	<label class="t" for="aiModelOllama">Model</label>
	<div class="row"><input type="text" id="aiModelOllama" list="ollamaList" value="${esc(f.aiProvider === 'ollama' ? f.aiModel : '')}" placeholder="the best installed model"><datalist id="ollamaList"></datalist></div>
	<div class="hint" id="ollamaHint"></div>
</div>
<div class="prov" data-for="custom">
	<label class="t" for="aiEndpointCustom">Base URL</label>
	<div class="row"><input type="text" id="aiEndpointCustom" value="${esc(f.aiProvider === 'custom' ? f.aiEndpoint : '')}" placeholder="https://api.example.com/v1"></div>
	<label class="t" for="aiModelCustom">Model(s)</label>
	<div class="hint">Several models of one provider can be listed, separated by commas.</div>
	<div class="row"><input type="text" id="aiModelCustom" value="${esc(f.aiProvider === 'custom' ? f.aiModel : '')}"></div>
</div>

<div class="using"><span id="using">Using now: checking…</span><button class="sec" data-run="i18nSync.testAi">Test</button></div>

<details>
	<summary>Advanced</summary>
	<div class="check"><input type="checkbox" id="aiUseCopilot" ${checked(f.aiUseCopilot)}><label for="aiUseCopilot">Use GitHub Copilot when it is available</label></div>
	<div class="check"><input type="checkbox" id="aiReviewPass" ${checked(f.aiReviewPass)}><label for="aiReviewPass">Proofread each batch with a second pass</label></div>
	<div class="hint">More accurate; one extra request per batch.</div>
	<div class="check"><input type="checkbox" id="aiAllowFree" ${checked(f.aiAllowFree)}><label for="aiAllowFree">Allow free online fallbacks</label></div>
	<div class="hint">When nothing else can translate, strings may be sent to a free AI service (OVHcloud AI Endpoints, EU) and to Google Translate. Untick to keep them off those services.</div>
	<div class="prov" data-for="gemini groq">
		<label class="t" for="aiModelPreset">Models (override)</label>
		<div class="hint">Leave empty to use the built-in list. Several models can be listed, separated by commas; the next one is used when one is limited.</div>
		<div class="row"><input type="text" id="aiModelPreset" value="${esc(f.aiProvider === 'gemini' || f.aiProvider === 'groq' ? f.aiModel : '')}"></div>
	</div>
	<div class="prov" data-for="ollama">
		<label class="t" for="aiEndpointOllama">Ollama address</label>
		<div class="row"><input type="text" id="aiEndpointOllama" value="${esc(f.aiProvider === 'ollama' ? f.aiEndpoint : '')}" placeholder="${OLLAMA_ADDRESS}"></div>
	</div>
</details>

<h2>4. Context file</h2>
<div class="hint">Product description, tone per language, approved glossary and names that must never be translated. Leave empty to use <code>i18n-context.json</code> inside the first translate destination if it exists; keeping it there shares it with your team.</div>
<div class="row"><input type="text" id="contextFile" value="${esc(f.contextFile)}"><button class="sec" data-browse="contextFile" data-file="1">Browse…</button></div>
<div class="row" style="margin-top:8px">
	<button class="sec" data-run="i18nSync.createContextTemplate">Create from template</button>
	<button class="sec" data-run="i18nSync.openContextFile">Open</button>
</div>

<div class="actions"><button id="save">Save</button></div>
<div id="msg"></div>

<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	const $ = (id) => document.getElementById(id);
	let locales = ${JSON.stringify(f.locales).replace(/</g, '\\u003c')};
	let dests = ${JSON.stringify(f.destinations).replace(/</g, '\\u003c')};
	const keysSaved = ${JSON.stringify(keysSaved)};
	const PRESET_MODELS = ${JSON.stringify(presetModels)};

	function renderChips() {
		$('chips').innerHTML = '';
		locales.forEach((l, i) => {
			const c = document.createElement('span');
			c.className = 'chip';
			c.textContent = l;
			const x = document.createElement('button');
			x.textContent = '×';
			x.title = 'Remove';
			x.onclick = () => { locales.splice(i, 1); renderChips(); };
			c.appendChild(x);
			$('chips').appendChild(c);
		});
	}
	function addLocale(v) {
		v = v.trim();
		if (v && !locales.includes(v)) locales.push(v);
	}
	function renderDests() {
		const box = $('dests');
		box.innerHTML = '';
		if (!dests.length) {
			const p = document.createElement('div');
			p.className = 'hint';
			p.textContent = 'No destination yet.';
			box.appendChild(p);
		}
		dests.forEach((d, i) => {
			const row = document.createElement('div');
			row.className = 'dest';
			const on = document.createElement('input');
			on.type = 'checkbox';
			on.checked = d.enabled;
			on.title = 'Include when syncing';
			on.onchange = () => { d.enabled = on.checked; };
			const path = document.createElement('input');
			path.type = 'text';
			path.value = d.path;
			path.placeholder = 'Folder';
			path.oninput = () => { d.path = path.value; };
			const browse = document.createElement('button');
			browse.className = 'sec';
			browse.textContent = 'Browse…';
			browse.onclick = () => vscode.postMessage({ type: 'browse', field: 'dest', index: i, current: d.path });
			const mode = document.createElement('select');
			[['translate', 'Translate into languages'], ['copy', 'Copy as it is']].forEach(([v, t]) => {
				const o = document.createElement('option');
				o.value = v;
				o.textContent = t;
				o.selected = d.mode === v;
				mode.appendChild(o);
			});
			mode.onchange = () => { d.mode = mode.value; };
			const x = document.createElement('button');
			x.className = 'sec x';
			x.textContent = '✕';
			x.title = 'Remove this destination';
			x.onclick = () => { dests.splice(i, 1); renderDests(); };
			row.append(on, path, browse, mode, x);
			box.appendChild(row);
		});
	}
	function show(kind, title, items) {
		const m = $('msg');
		m.className = kind;
		m.innerHTML = '';
		m.append(title);
		if (items && items.length) {
			const ul = document.createElement('ul');
			items.forEach((t) => { const li = document.createElement('li'); li.textContent = t; ul.appendChild(li); });
			m.appendChild(ul);
		}
	}

	// the fields under the provider dropdown follow the choice
	function showProvider() {
		const p = $('aiProvider').value;
		document.querySelectorAll('.prov').forEach((el) => { el.style.display = el.dataset.for.split(' ').includes(p) ? '' : 'none'; });
		$('aiModelPreset').placeholder = PRESET_MODELS[p] || '';
		$('aiKey').value = '';
		$('aiKey').placeholder = keysSaved[p] ? '••••••••' : '';
		$('keyHint').textContent = keysSaved[p]
			? 'A key is saved on this machine. Type a new one to replace it.'
			: p === 'custom' ? 'Optional for servers that need no key. Kept in VS Code secret storage on this machine only.' : 'Paste your key. It is kept in VS Code secret storage on this machine only.';
		if (p === 'ollama') {
			$('ollamaHint').textContent = 'Looking for installed models…';
			vscode.postMessage({ type: 'ollamaModels', address: $('aiEndpointOllama').value.trim() });
		}
	}
	function chosenModel(p) {
		return p === 'ollama' ? $('aiModelOllama').value : p === 'custom' ? $('aiModelCustom').value : (p === 'gemini' || p === 'groq') ? $('aiModelPreset').value : '';
	}
	function chosenEndpoint(p) {
		return p === 'custom' ? $('aiEndpointCustom').value : p === 'ollama' ? $('aiEndpointOllama').value : '';
	}

	document.querySelectorAll('[data-browse]').forEach((b) => b.onclick = () => {
		const field = b.dataset.browse;
		vscode.postMessage({ type: 'browse', field, file: !!b.dataset.file, current: $(field).value });
	});
	document.querySelectorAll('[data-run]').forEach((b) => b.onclick = () => vscode.postMessage({ type: 'run', command: b.dataset.run }));
	document.querySelectorAll('[data-open]').forEach((b) => b.onclick = () => vscode.postMessage({ type: 'open', url: b.dataset.open }));
	$('aiProvider').onchange = showProvider;
	$('aiEndpointOllama').onchange = showProvider;
	$('add').onclick = () => { addLocale($('newLocale').value); $('newLocale').value = ''; renderChips(); };
	$('newLocale').onkeydown = (e) => { if (e.key === 'Enter') $('add').click(); };
	$('addDest').onclick = () => { dests.push({ path: '', mode: 'translate', enabled: true }); renderDests(); };
	$('detect').onclick = () => {
		const d = dests.find((x) => x.mode === 'translate' && x.path.trim());
		if (!d) return show('err', 'Add a destination that translates into languages first.');
		vscode.postMessage({ type: 'detect', dir: d.path });
	};
	$('save').onclick = () => {
		const p = $('aiProvider').value;
		vscode.postMessage({ type: 'save', form: {
			source: $('source').value.trim(),
			destinations: dests.map((d) => ({ path: d.path.trim(), mode: d.mode, enabled: d.enabled })),
			locales,
			sourceLocale: $('sourceLocale').value.trim(),
			enabled: $('enabled').checked,
			onlyOwnCommits: $('onlyOwnCommits').checked,
			askDestinations: $('askDestinations').checked,
			contextFile: $('contextFile').value.trim(),
			aiProvider: p,
			aiEndpoint: chosenEndpoint(p).trim(),
			aiModel: chosenModel(p).trim(),
			aiUseCopilot: $('aiUseCopilot').checked,
			aiReviewPass: $('aiReviewPass').checked,
			aiAllowFree: $('aiAllowFree').checked,
			aiKey: $('aiKey').value.trim(),
		}});
	};

	window.addEventListener('message', (e) => {
		const m = e.data;
		if (m.type === 'picked') {
			if (m.field === 'dest') {
				dests[m.index].path = m.value;
				renderDests();
				if (!locales.length && dests[m.index].mode === 'translate') vscode.postMessage({ type: 'detect', dir: m.value });
			} else {
				$(m.field).value = m.value;
			}
		} else if (m.type === 'detected') {
			if (!m.locales.length) return show('err', 'No language sub-folders found in that destination.');
			m.locales.forEach(addLocale);
			renderChips();
			show('ok', 'Found: ' + m.locales.join(', '));
		} else if (m.type === 'using') {
			$('using').textContent = 'Using now: ' + m.text;
		} else if (m.type === 'ollamaModels') {
			const list = $('ollamaList');
			list.innerHTML = '';
			m.models.forEach((name) => { const o = document.createElement('option'); o.value = name; list.appendChild(o); });
			$('ollamaHint').textContent = m.models.length ? 'Installed: ' + m.models.join(', ') : 'Ollama is not running at that address, or it has no models yet.';
		} else if (m.type === 'errors') {
			show('err', 'Fix these first:', m.errors);
		} else if (m.type === 'saved') {
			show('ok', 'Saved.', m.warnings);
			if ($('aiKey').value.trim()) keysSaved[$('aiProvider').value] = true;
			showProvider();
			vscode.postMessage({ type: 'using' });
		}
	});
	renderChips();
	renderDests();
	showProvider();
	vscode.postMessage({ type: 'using' });
</script>
</body></html>`;
}
