import { findNodeAtLocation, parseTree } from 'jsonc-parser';
import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import type { PendingStore } from './pending';
import type { ScanResult } from './syncSource';
import { renderStatus, StatusData, Target } from './statusView';

/** Line (0-based) of a key in a JSON file, if it can be found. */
async function lineOf(file: string, keyPath: (string | number)[]): Promise<number | undefined> {
	try {
		const text = (await fs.readFile(file, 'utf8')).replace(/^﻿/, '');
		const node = findNodeAtLocation(parseTree(text) ?? ({} as never), keyPath);
		return node ? text.slice(0, node.offset).split('\n').length - 1 : undefined;
	} catch {
		return undefined;
	}
}

export interface StatusDeps {
	pending: PendingStore;
	roots: () => string[];
	configured: () => boolean;
	syncsLocales: () => boolean;
	/** a dry run of Sync Locales */
	scan: () => Promise<ScanResult>;
	lastError: () => { at: number; message: string } | undefined;
	/** how the last sync that translated something went: which models and services made the strings */
	lastSync: () => { at: number; text: string } | undefined;
	/** Sync All Missing: whole files, not only the changes since the last commit */
	syncAll: () => Promise<void>;
	retryPending: () => Promise<void>;
}

let panel: vscode.WebviewPanel | undefined;
let current: StatusDeps | undefined;
let targets: Target[] = [];
let busy = false;
let again = false;
let timer: NodeJS.Timeout | undefined;

async function render(): Promise<void> {
	if (!panel || !current) {
		return;
	}
	if (busy) {
		again = true;
		return;
	}
	busy = true;
	void panel.webview.postMessage({ type: 'busy', on: true });
	try {
		const d = current;
		const data: StatusData = { configured: d.configured(), roots: d.roots(), pending: await d.pending.all(), lastError: d.lastError(), lastSync: d.lastSync(), at: Date.now(), syncsLocales: d.syncsLocales() };
		if (data.configured) {
			try {
				data.scan = await d.scan();
			} catch (e) {
				data.scanError = (e as Error).message;
			}
		}
		const r = renderStatus(data);
		targets = r.targets;
		void panel?.webview.postMessage({ type: 'render', html: r.html });
	} finally {
		busy = false;
		void panel?.webview.postMessage({ type: 'busy', on: false });
		if (again) {
			again = false;
			void render();
		}
	}
}

/** Called whenever something changed (a sync finished, the queue changed): redraw the page if it is open. */
export function refreshStatusPanel(): void {
	if (!panel) {
		return;
	}
	clearTimeout(timer);
	timer = setTimeout(() => void render(), 800);
}

export function openStatusPanel(ctx: vscode.ExtensionContext, deps: StatusDeps): void {
	current = deps;
	if (panel) {
		panel.reveal();
		void render();
		return;
	}
	panel = vscode.window.createWebviewPanel('i18nSyncStatus', 'i18n Sync: Translation Status', vscode.ViewColumn.Active, { enableScripts: true });
	panel.onDidDispose(() => (panel = undefined), null, ctx.subscriptions);
	const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
	panel.webview.html = page(nonce, panel.webview.cspSource);
	panel.webview.onDidReceiveMessage(
		async (m) => {
			const run = async (fn: () => Promise<void>) => {
				void panel?.webview.postMessage({ type: 'busy', on: true });
				try {
					await fn();
				} finally {
					await render();
				}
			};
			if (m.type === 'rescan') {
				await render();
			} else if (m.type === 'sync') {
				await run(() => deps.syncAll());
			} else if (m.type === 'retry') {
				await run(() => deps.retryPending());
			} else if (m.type === 'quality') {
				await vscode.commands.executeCommand('i18nSync.qualityCheck');
			} else if (m.type === 'stop') {
				await vscode.commands.executeCommand('i18nSync.stop');
			} else if (m.type === 'apply') {
				await vscode.commands.executeCommand('i18nSync.applyAiAnswer');
			} else if (m.type === 'chat') {
				await vscode.commands.executeCommand('i18nSync.copyAiPrompt');
			} else if (m.type === 'log') {
				await vscode.commands.executeCommand('i18nSync.showLog');
			} else if (m.type === 'open') {
				const t = targets[Number(m.id)];
				if (t) {
					try {
						const line = t.line !== undefined ? t.line - 1 : t.keyPath ? await lineOf(t.file, t.keyPath) : undefined;
						const pos = new vscode.Position(Math.max(0, line ?? 0), 0);
						await vscode.window.showTextDocument(vscode.Uri.file(t.file), { selection: new vscode.Range(pos, pos) });
					} catch {
						void vscode.window.showWarningMessage(`Cannot open ${t.file}: the file does not exist yet.`);
					}
				}
			}
		},
		undefined,
		ctx.subscriptions,
	);
	void render();
}

function page(nonce: string, csp: string): string {
	return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
	body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px 24px 48px; max-width: 900px; }
	h1 { font-size: 1.4em; font-weight: 600; margin: 0 0 8px; }
	h2 { font-size: 1.1em; font-weight: 600; margin: 28px 0 4px; padding-bottom: 4px; border-bottom: 1px solid var(--vscode-panel-border, #8884); }
	h3 { font-size: 1em; font-weight: 600; margin: 14px 0 2px; }
	.hint { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin: 2px 0 6px; }
	.empty { color: var(--vscode-descriptionForeground); }
	.bar { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0 16px; }
	button { padding: 4px 12px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; cursor: pointer; }
	button:hover { background: var(--vscode-button-hoverBackground); }
	button.sec { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
	button:disabled { opacity: 0.5; cursor: default; }
	.cards { display: flex; gap: 10px; flex-wrap: wrap; margin: 8px 0; }
	.card { flex: 1; min-width: 150px; padding: 8px 12px; border: 1px solid var(--vscode-panel-border, #8884); border-radius: 6px; }
	.card.warn { border-color: var(--vscode-editorWarning-foreground, #cca700); }
	.card .n { font-size: 1.6em; font-weight: 600; }
	.banner { margin: 8px 0; padding: 8px 10px; border-left: 3px solid var(--vscode-errorForeground); }
	table { border-collapse: collapse; width: 100%; margin: 6px 0; }
	th, td { text-align: left; padding: 3px 10px 3px 0; vertical-align: top; border-bottom: 1px solid var(--vscode-panel-border, #8882); }
	th { color: var(--vscode-descriptionForeground); font-weight: 500; }
	details { margin: 6px 0; }
	summary { cursor: pointer; }
	.file { margin-top: 8px; }
	ul { margin: 2px 0 6px 18px; padding: 0; }
	a { color: var(--vscode-textLink-foreground); }
	code { font-family: var(--vscode-editor-font-family); }
	#state { color: var(--vscode-descriptionForeground); margin-left: 8px; align-self: center; }
</style></head>
<body>
<h1>Translation status</h1>
<div class="bar">
	<button data-act="sync" title="Compare the whole files and translate every key that is missing or out of date, not only what changed since the last commit">Sync all missing</button>
	<button class="sec" data-act="stop" data-keep="1" title="Stop the translation that is running and drop what is queued behind it">Stop</button>
	<button class="sec" data-act="retry" title="Try again only the strings that are waiting for a translator">Retry waiting strings</button>
	<button class="sec" data-act="rescan">Rescan</button>
	<button class="sec" data-act="chat" title="Copy a prompt for the AI chat you already use">Improve with my AI chat</button>
	<button class="sec" data-act="apply" title="Paste the chat's answer back from the clipboard">Apply AI answer</button>
	<button class="sec" data-act="quality" title="Score the translator against translations you already approved">Check quality</button>
	<button class="sec" data-act="log">Show log</button>
	<span id="state"></span>
</div>
<div id="root"><p class="empty">Checking…</p></div>
<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	const root = document.getElementById('root');
	const state = document.getElementById('state');
	const buttons = [...document.querySelectorAll('button')];
	document.addEventListener('click', (e) => {
		const b = e.target.closest('button[data-act]');
		if (b && !b.disabled) {
			vscode.postMessage({ type: b.dataset.act });
			return;
		}
		const a = e.target.closest('a[data-open]');
		if (a) {
			e.preventDefault();
			vscode.postMessage({ type: 'open', id: a.dataset.open });
		}
	});
	window.addEventListener('message', (e) => {
		const m = e.data;
		if (m.type === 'busy') {
			buttons.forEach((b) => { if (!b.dataset.keep) b.disabled = m.on; });
			state.textContent = m.on ? 'Working…' : '';
		} else if (m.type === 'render') {
			const open = new Set([...root.querySelectorAll('details[open]')].map((d) => d.dataset.id));
			root.innerHTML = m.html;
			root.querySelectorAll('details').forEach((d) => { if (open.has(d.dataset.id)) d.open = true; });
		}
	});
</script>
</body></html>`;
}
