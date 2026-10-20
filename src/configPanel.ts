import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const SECTION = 'localeSync';

interface Form {
	sourceDir: string;
	targetDir: string;
	locales: string[];
	sourceLocale: string;
	onlyOwnCommits: boolean;
	enabled: boolean;
}

const isDir = (p: string) => {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
};

function load(): Form {
	const c = vscode.workspace.getConfiguration(SECTION);
	return {
		sourceDir: c.get('sourceDir', ''),
		targetDir: c.get('targetDir', ''),
		locales: c.get('locales', []),
		sourceLocale: c.get('sourceLocale', 'en'),
		onlyOwnCommits: c.get('onlyOwnCommits', true),
		enabled: c.get('enabled', true),
	};
}

/** Problems that would stop the sync from working; empty = good to save. */
function validate(f: Form): string[] {
	const errs: string[] = [];
	if (!f.sourceDir) {
		errs.push('Choose the source folder (the English locale folder in the FE repo).');
	} else if (!isDir(f.sourceDir)) {
		errs.push('Source folder does not exist.');
	}
	if (!f.targetDir) {
		errs.push('Choose the target folder (the "locales" folder in the translation repo).');
	} else if (!isDir(f.targetDir)) {
		errs.push('Target folder does not exist.');
	}
	if (!f.locales.length) {
		errs.push('Add at least one locale.');
	}
	if (!f.sourceLocale.trim()) {
		errs.push('Source locale is required.');
	}
	return errs;
}

let panel: vscode.WebviewPanel | undefined;

export function openConfigPanel(ctx: vscode.ExtensionContext, onSaved: () => void) {
	if (panel) {
		panel.reveal();
		return;
	}
	panel = vscode.window.createWebviewPanel('localeSyncConfig', 'Translation Key Sync: Settings', vscode.ViewColumn.Active, {
		enableScripts: true,
	});
	panel.onDidDispose(() => (panel = undefined), null, ctx.subscriptions);
	const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
	panel.webview.html = html(nonce, panel.webview.cspSource, load());

	panel.webview.onDidReceiveMessage(
		async (m) => {
			if (m.type === 'browse') {
				const pick = await vscode.window.showOpenDialog({
					canSelectFolders: true,
					canSelectFiles: false,
					canSelectMany: false,
					defaultUri: m.current && isDir(m.current) ? vscode.Uri.file(m.current) : undefined,
					openLabel: 'Select folder',
				});
				if (pick?.[0]) {
					panel?.webview.postMessage({ type: 'picked', field: m.field, value: pick[0].fsPath });
				}
			} else if (m.type === 'detect') {
				// every sub-folder of the target dir is a locale
				const dir: string = m.targetDir;
				const found = isDir(dir)
					? fs.readdirSync(dir).filter((d) => isDir(path.join(dir, d)) && !d.startsWith('.'))
					: [];
				panel?.webview.postMessage({ type: 'detected', locales: found });
			} else if (m.type === 'save') {
				const form: Form = m.form;
				const errs = validate(form);
				if (errs.length) {
					panel?.webview.postMessage({ type: 'errors', errors: errs });
					return;
				}
				const c = vscode.workspace.getConfiguration(SECTION);
				const T = vscode.ConfigurationTarget.Global; // paths are per machine, not per project
				for (const [k, v] of Object.entries(form)) {
					await c.update(k, v, T);
				}
				const warn: string[] = [];
				const missing = form.locales.filter((l) => !isDir(path.join(form.targetDir, l)));
				if (missing.length) {
					warn.push(`No folder yet for: ${missing.join(', ')} (it will be created on first sync).`);
				}
				const hasRepo = (vscode.workspace.workspaceFolders ?? []).length > 0;
				if (!hasRepo) {
					warn.push('Open the FE repo folder in VS Code so commits can be detected.');
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

function html(nonce: string, csp: string, f: Form): string {
	return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
	body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px 24px; max-width: 720px; }
	h1 { font-size: 1.4em; font-weight: 600; margin: 0 0 4px; }
	p.sub { color: var(--vscode-descriptionForeground); margin: 0 0 20px; }
	label.t { display: block; font-weight: 600; margin: 18px 0 2px; }
	.hint { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-bottom: 6px; }
	.row { display: flex; gap: 6px; }
	input[type=text] { flex: 1; min-width: 0; padding: 4px 6px; color: var(--vscode-input-foreground);
		background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); }
	input[type=text]:focus { outline: 1px solid var(--vscode-focusBorder); }
	button { padding: 4px 12px; color: var(--vscode-button-foreground); background: var(--vscode-button-background);
		border: 0; cursor: pointer; }
	button:hover { background: var(--vscode-button-hoverBackground); }
	button.sec { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
	.chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
	.chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 4px 2px 8px; border-radius: 10px;
		color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); }
	.chip button { padding: 0 4px; background: transparent; color: inherit; }
	.check { margin: 12px 0; display: flex; gap: 6px; align-items: flex-start; }
	#msg { margin-top: 16px; padding: 8px 10px; display: none; border-left: 3px solid; }
	#msg.err { display: block; border-color: var(--vscode-errorForeground); }
	#msg.ok { display: block; border-color: var(--vscode-testing-iconPassed, #3a3); }
	#msg ul { margin: 4px 0 0 18px; padding: 0; }
	.actions { margin-top: 24px; }
</style></head>
<body>
<h1>Translation Key Sync settings</h1>
<p class="sub">Tell the extension where your FE repo and translation repo live on this machine.</p>

<label class="t" for="sourceDir">Source folder (FE repo)</label>
<div class="hint">The English locale folder, e.g. <code>C:\\FE\\wh-react-web-frontend\\public\\translations\\fallback\\locales\\en</code></div>
<div class="row"><input type="text" id="sourceDir" value="${esc(f.sourceDir)}"><button class="sec" data-browse="sourceDir">Browse…</button></div>

<label class="t" for="targetDir">Target folder (translation repo)</label>
<div class="hint">The <code>locales</code> folder that contains one sub-folder per language, e.g. <code>C:\\FE\\wh-translation-docs\\locales</code></div>
<div class="row"><input type="text" id="targetDir" value="${esc(f.targetDir)}"><button class="sec" data-browse="targetDir">Browse…</button></div>

<label class="t">Locales to sync</label>
<div class="hint">Sub-folders of the target folder that receive translations.</div>
<div class="chips" id="chips"></div>
<div class="row">
	<input type="text" id="newLocale" placeholder="e.g. fr">
	<button class="sec" id="add">Add</button>
	<button class="sec" id="detect">Detect from target folder</button>
</div>

<label class="t" for="sourceLocale">Source language</label>
<div class="hint">This locale is copied as-is, not translated.</div>
<div class="row"><input type="text" id="sourceLocale" value="${esc(f.sourceLocale)}" style="max-width:120px;flex:none"></div>

<div class="check"><input type="checkbox" id="enabled" ${f.enabled ? 'checked' : ''}><label for="enabled">Sync automatically after each commit</label></div>
<div class="check"><input type="checkbox" id="onlyOwnCommits" ${f.onlyOwnCommits ? 'checked' : ''}><label for="onlyOwnCommits">Only sync commits authored by me (ignores pulled commits)</label></div>

<div class="actions"><button id="save">Save</button></div>
<div id="msg"></div>

<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	const $ = (id) => document.getElementById(id);
	let locales = ${JSON.stringify(f.locales).replace(/</g, '\\u003c')};

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

	document.querySelectorAll('[data-browse]').forEach((b) => b.onclick = () => {
		const field = b.dataset.browse;
		vscode.postMessage({ type: 'browse', field, current: $(field).value });
	});
	$('add').onclick = () => { addLocale($('newLocale').value); $('newLocale').value = ''; renderChips(); };
	$('newLocale').onkeydown = (e) => { if (e.key === 'Enter') $('add').click(); };
	$('detect').onclick = () => vscode.postMessage({ type: 'detect', targetDir: $('targetDir').value });
	$('save').onclick = () => vscode.postMessage({ type: 'save', form: {
		sourceDir: $('sourceDir').value.trim(),
		targetDir: $('targetDir').value.trim(),
		locales,
		sourceLocale: $('sourceLocale').value.trim(),
		enabled: $('enabled').checked,
		onlyOwnCommits: $('onlyOwnCommits').checked,
	}});

	window.addEventListener('message', (e) => {
		const m = e.data;
		if (m.type === 'picked') {
			$(m.field).value = m.value;
			if (m.field === 'targetDir' && !locales.length) vscode.postMessage({ type: 'detect', targetDir: m.value });
		} else if (m.type === 'detected') {
			if (!m.locales.length) return show('err', 'No locale sub-folders found in the target folder.');
			m.locales.forEach(addLocale);
			renderChips();
			show('ok', 'Found: ' + m.locales.join(', '));
		} else if (m.type === 'errors') {
			show('err', 'Fix these first:', m.errors);
		} else if (m.type === 'saved') {
			show('ok', 'Saved. Translation Key Sync will run after your next commit.', m.warnings);
		}
	});
	renderChips();
</script>
</body></html>`;
}
