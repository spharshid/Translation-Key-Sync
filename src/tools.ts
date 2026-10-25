import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { AiEngine } from './ai/engine';
import { keySlot, PRESETS } from './ai/endpoint';
import { flattenStrings, pickReferences } from './ai/refs';
import { chrf } from './ai/score';
import { CONTEXT_SCHEMA, CONTEXT_TEMPLATE, defaultContextPath } from './context';
import { Runtime, Settings, contextPath, readSettings } from './runtime';
import { parse } from 'jsonc-parser';

type Log = (m: string) => void;

/**
 * Sends a few sample strings to the configured AI model and shows the result. Because it runs from a command, this is
 * also where VS Code asks the user for permission to let the extension use Copilot.
 */
export async function testAi(rt: Runtime, log: Log, out: vscode.OutputChannel): Promise<void> {
	const s = readSettings();
	const using = await rt.usingNow(s);
	log(`AI in use: ${using}`);
	const clients = await rt.aiClients(s);
	if (!clients.length) {
		out.show(true);
		const pick = await vscode.window.showWarningMessage(
			`No AI model can be used automatically here (using ${using}). GitHub Copilot is only available in VS Code itself (not in forks such as Cursor, Trae or Antigravity). You can still get AI-quality translations for free: "Improve with my AI chat" copies one prompt for the AI chat you already use, and applies its reply.`,
			{ modal: true },
			'Improve with my AI chat',
			'Open settings',
		);
		if (pick === 'Open settings') {
			void vscode.commands.executeCommand('workbench.action.openSettings', 'i18nSync.ai');
		} else if (pick) {
			void vscode.commands.executeCommand('i18nSync.copyAiPrompt');
		}
		return;
	}
	const locale = s.cfg.locales.find((l) => l !== s.cfg.sourceLocale) ?? 'es';
	const context = await rt.loadContext(s);
	const items = [
		{ id: 's0', text: 'Save changes', keyPath: 'buttons.save' },
		{ id: 's1', text: 'Hello {{name}}, you have {{count}} new messages', keyPath: 'dashboard.greeting' },
		{ id: 's2', text: 'Are you sure you want to delete this item? This action cannot be undone.', keyPath: 'dialogs.delete.confirm' },
	];
	const term = context.glossary.find((g) => g.translations[locale]);
	if (term) {
		items.push({ id: 's3', text: `Open the ${term.term}`, keyPath: 'glossary.example' });
	}
	const engine = new AiEngine({ clients, context, sourceLocale: s.cfg.sourceLocale, reviewPass: false, log });
	out.show(true);
	await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Testing AI translation...' }, async () => {
		const res = await engine.translate({ locale, file: 'test.json', items, refs: [] });
		if (!res.size) {
			void vscode.window.showErrorMessage('The AI model did not answer. See the "i18n AI Translate & Sync" output for the reason.');
			return;
		}
		const lines = items.map((i) => `  ${i.text}\n  -> ${res.get(i.id)?.value ?? '(no answer)'}${res.get(i.id)?.problems.length ? `   [${res.get(i.id)!.problems.join('; ')}]` : ''}`);
		const model = [...res.values()][0].model;
		log(`AI test (${locale}) with ${model}:\n${lines.join('\n')}`);
		void vscode.window.showInformationMessage(`AI translation works with ${model}. Sample (${locale}): "${res.get('s0')?.value}"`, 'Show details').then((p) => p && out.show());
	});
}

/** Write the context-file template (and its JSON schema) and open it. */
export async function createContextTemplate(s: Settings): Promise<string | undefined> {
	const suggested = contextPath(s) || (s.localesDir ? defaultContextPath(s.localesDir) : '');
	const uri = await vscode.window.showSaveDialog({
		defaultUri: suggested ? vscode.Uri.file(suggested) : undefined,
		filters: { 'Context file': ['json'] },
		title: 'Where should the context file be saved? (the DestinationRepo is a good place so the team shares it)',
	});
	if (!uri) {
		return undefined;
	}
	try {
		await fs.access(uri.fsPath);
		const overwrite = await vscode.window.showWarningMessage(`${path.basename(uri.fsPath)} already exists. Overwrite it with the template?`, { modal: true }, 'Overwrite');
		if (overwrite !== 'Overwrite') {
			return uri.fsPath;
		}
	} catch {
		// does not exist yet
	}
	await fs.mkdir(path.dirname(uri.fsPath), { recursive: true });
	await fs.writeFile(uri.fsPath, JSON.stringify(CONTEXT_TEMPLATE, null, 2) + '\n', 'utf8');
	await fs.writeFile(path.join(path.dirname(uri.fsPath), 'i18n-context.schema.json'), JSON.stringify(CONTEXT_SCHEMA, null, 2) + '\n', 'utf8');
	await vscode.workspace.getConfiguration('i18nSync').update('contextFile', uri.fsPath, vscode.ConfigurationTarget.Global);
	await vscode.window.showTextDocument(uri);
	return uri.fsPath;
}

/** Save or remove the API key of the AI provider chosen in the settings (also reachable from the command palette). */
export async function setApiKey(secrets: vscode.SecretStorage): Promise<void> {
	const picked = readSettings().ai.provider;
	const provider = picked === 'gemini' || picked === 'groq' ? picked : 'custom';
	const key = await vscode.window.showInputBox({
		title: `API key for ${provider === 'custom' ? 'the custom AI endpoint' : PRESETS[provider].label}`,
		prompt: 'Stored in VS Code secret storage on this machine only. Leave empty to remove the saved key.',
		password: true,
		ignoreFocusOut: true,
	});
	if (key === undefined) {
		return;
	}
	if (key.trim()) {
		await secrets.store(keySlot(provider), key.trim());
		void vscode.window.showInformationMessage('API key saved.');
	} else {
		await secrets.delete(keySlot(provider));
		void vscode.window.showInformationMessage('API key removed.');
	}
}

const readJson = async (file: string) => {
	try {
		return parse((await fs.readFile(file, 'utf8')).replace(/^﻿/, ''));
	} catch {
		return undefined;
	}
};

async function listJson(dir: string, base = dir): Promise<string[]> {
	const out: string[] = [];
	let entries: import('fs').Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		const full = path.join(dir, e.name);
		if (e.isDirectory()) {
			out.push(...(await listJson(full, base)));
		} else if (e.name.endsWith('.json')) {
			out.push(path.relative(base, full).split(path.sep).join('/'));
		}
	}
	return out.sort();
}

/**
 * Translate a sample of strings that already have an approved translation in the DestinationRepo and score the result
 * against it (chrF), for the AI engine and for plain machine translation. Nothing is written to any locale file.
 */
export async function qualityCheck(rt: Runtime, log: Log, sampleSize = 20): Promise<void> {
	const s = readSettings();
	if (!s.configured) {
		void vscode.window.showWarningMessage('Set up i18n AI Translate & Sync first.');
		return;
	}
	if (!s.localesDir) {
		void vscode.window.showWarningMessage('The quality check needs a destination that translates into languages.');
		return;
	}
	const targets = s.cfg.locales.filter((l) => l !== s.cfg.sourceLocale);
	const locale = await vscode.window.showQuickPick(targets, { title: 'Check translation quality for which language?' });
	if (!locale) {
		return;
	}
	const enDir = path.join(s.localesDir, s.cfg.sourceLocale);

	type Sample = { file: string; keyPath: string; en: string; ref: string; srcDoc: unknown; tgtDoc: unknown };
	const pool: Sample[] = [];
	for (const rel of await listJson(enDir)) {
		const srcDoc = await readJson(path.join(enDir, rel));
		const tgtDoc = await readJson(path.join(s.localesDir, locale, rel));
		if (!srcDoc || !tgtDoc) {
			continue;
		}
		const tgt = flattenStrings(tgtDoc);
		for (const [k, en] of flattenStrings(srcDoc)) {
			const ref = tgt.get(k);
			if (ref && ref !== en && en.length >= 8 && en.length <= 200) {
				pool.push({ file: rel, keyPath: k, en, ref, srcDoc, tgtDoc });
			}
		}
	}
	if (pool.length < 3) {
		void vscode.window.showWarningMessage(`Not enough existing ${locale} translations in the DestinationRepo to compare against.`);
		return;
	}
	const step = Math.max(1, Math.floor(pool.length / sampleSize));
	const sample = pool.filter((_, i) => i % step === 0).slice(0, sampleSize);

	await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Checking ${sample.length} ${locale} strings...` }, async () => {
		const run = async (ai: boolean) => {
			const service = await rt.buildService(s, sample.length, undefined, ai ? undefined : [], false);
			const out = new Map<number, { value: string; origin: string }>();
			const byFile = new Map<string, number[]>();
			sample.forEach((x, i) => byFile.set(x.file, [...(byFile.get(x.file) ?? []), i]));
			for (const [file, idx] of byFile) {
				const items = idx.map((i) => ({ id: `s${i}`, text: sample[i].en, keyPath: sample[i].keyPath }));
				const refs = pickReferences(sample[idx[0]].srcDoc, sample[idx[0]].tgtDoc, items);
				const res = await service.translateBatch({ locale, file, items, refs });
				for (const i of idx) {
					const r = res.get(`s${i}`);
					if (r) {
						out.set(i, { value: r.value, origin: r.origin });
					}
				}
			}
			return out;
		};
		const aiRes = await run(true);
		const machine = await run(false);
		const mean = (m: Map<number, { value: string }>) => (sample.length ? [...m].reduce((a, [i, v]) => a + chrf(v.value, sample[i].ref), 0) / sample.length : 0);
		const origins = [...aiRes.values()].reduce<Record<string, number>>((a, v) => ((a[v.origin] = (a[v.origin] ?? 0) + 1), a), {});
		const rows = sample
			.map((x, i) => ({ x, ai: aiRes.get(i)?.value ?? '', mt: machine.get(i)?.value ?? '', sai: chrf(aiRes.get(i)?.value ?? '', x.ref), smt: chrf(machine.get(i)?.value ?? '', x.ref) }))
			.sort((a, b) => a.sai - b.sai);
		const md = [
			`# Translation quality check (${locale})`,
			'',
			`Sampled **${sample.length}** strings that already have an approved ${locale} translation in the DestinationRepo, translated them again and scored them against the approved text (chrF, 0-100).`,
			'',
			`| Engine | Average score |`,
			`|---|---|`,
			`| AI model (with context) | **${(mean(aiRes) * 100).toFixed(1)}** |`,
			`| Machine translation only (Google / Space) | ${(mean(machine) * 100).toFixed(1)} |`,
			'',
			`AI engine result origins: ${JSON.stringify(origins)}  (ai = AI model answered; classic/english = it fell back)`,
			'',
			'The score measures similarity to your approved wording. A correct translation phrased differently scores lower, so read the lowest rows below and judge them yourself.',
			'',
			'## Lowest-scoring AI results',
			'',
			...rows.slice(0, 10).flatMap((r) => [
				`### \`${r.x.file}\` -> \`${r.x.keyPath}\`  (AI ${(r.sai * 100).toFixed(0)} / machine ${(r.smt * 100).toFixed(0)})`,
				`- English: ${r.x.en}`,
				`- Approved: ${r.x.ref}`,
				`- AI: ${r.ai}`,
				`- Machine: ${r.mt}`,
				'',
			]),
		].join('\n');
		log(`quality check ${locale}: AI ${(mean(aiRes) * 100).toFixed(1)} vs machine ${(mean(machine) * 100).toFixed(1)}`);
		const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: md });
		await vscode.window.showTextDocument(doc);
	});
}
