import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { keySlot } from './ai/endpoint';
import { listOllamaModels } from './ai/local';
import { ConfigDeps, isConfigured, openConfigPanel } from './configPanel';
import { git, getCommitInfo, getUserEmail } from './git';
import { Journal } from './journal';
import { applyManualAnswer, buildManualPrompt, Awaiting } from './manualAi';
import { PendingStore, retryPending } from './pending';
import { Runtime, Settings, contextPath, readSettings } from './runtime';
import { SnapshotStore } from './snapshot';
import { Destination, describeDestination } from './destinations';
import { openStatusPanel, refreshStatusPanel } from './statusPanel';
import { syncCommit } from './syncCommit';
import { scanSource, syncFromSource } from './syncSource';
import { createContextTemplate, qualityCheck, setApiKey, testAi } from './tools';

interface GitRepo {
	rootUri: vscode.Uri;
	state: { HEAD?: { name?: string; commit?: string }; onDidChange: vscode.Event<void> };
	status(): Promise<void>;
}
interface GitAPI {
	git: { path: string };
	repositories: GitRepo[];
	onDidOpenRepository: vscode.Event<GitRepo>;
}

const NAME = 'i18n AI Translate & Sync';

let out: vscode.OutputChannel;
const log = (m: string) => out.appendLine(`${new Date().toLocaleTimeString()} ${m}`);

/** Does this repo contain the configured source dir? */
function ownsSource(repo: GitRepo, sourceDir: string) {
	const rel = path.relative(repo.rootUri.fsPath, sourceDir);
	return !!sourceDir && !rel.startsWith('..') && !path.isAbsolute(rel);
}

let queue: Promise<unknown> = Promise.resolve();
let rt: Runtime;
let pendingStore: PendingStore;
let journal: Journal;
let storageDir: string;
let refreshStatus: () => void = () => undefined;
let state: vscode.Memento;
/** files and keys the last sync could not touch because their content is broken */
let lastIssues = 0;
const LAST_ERROR = 'lastSyncError';
let snapshots: SnapshotStore;

/** Ask which of the ticked destinations this batch should go to (only when there is a choice). undefined = cancelled. */
async function chooseDestinations(s: Settings): Promise<Destination[] | undefined> {
	const all = s.cfg.destinations;
	if (all.length < 2 || !s.askDestinations) {
		return all;
	}
	const items = all.map((dest) => ({
		label: path.basename(dest.path) || dest.path,
		description: describeDestination(dest, s.cfg.locales, s.cfg.sourceLocale),
		detail: dest.path,
		picked: true,
		dest,
	}));
	const picked = await vscode.window.showQuickPick(items, {
		canPickMany: true,
		title: `${NAME}: where should this batch go?`,
		placeHolder: 'Untick a destination to leave it out of this sync',
	});
	return picked?.map((p) => p.dest);
}

let lastMachineNotice = 0;
/** Tell the user, at most every half hour, that machine translation was used because no AI model answered. */
function noticeMachine(count: number, s: Settings) {
	if (!count || !s.ai.enabled || Date.now() - lastMachineNotice < 30 * 60_000) {
		return;
	}
	lastMachineNotice = Date.now();
	void vscode.window
		.showWarningMessage(
			`${NAME}: ${count} string(s) were translated with machine translation because no AI model was available, so they are lower quality. They are queued and redone automatically when an AI model becomes available. If your team shares one office network, the free AI service is shared by everyone on it (2 requests/min per model): pick an AI provider with a free key of your own in the settings (Translation). Or improve them now with the AI chat you already use.`,
			'Improve with my AI chat',
			'Test AI Translation',
		)
		.then((p) => {
			if (p === 'Improve with my AI chat') {
				void vscode.commands.executeCommand('i18nSync.copyAiPrompt');
			} else if (p) {
				void vscode.commands.executeCommand('i18nSync.testAi');
			}
		});
}

/** Remember how the last sync ended, for the status bar and the Translation Status page. */
function recordRun(error?: string, issues = 0) {
	lastIssues = issues;
	void state.update(LAST_ERROR, error ? { at: Date.now(), message: error } : undefined);
	refreshStatus();
}

function noticeIssues(count: number) {
	void vscode.window
		.showWarningMessage(`${NAME}: ${count} file(s) or key(s) were left untouched because their content is broken (invalid JSON or a different structure).`, 'Show details')
		.then((p) => p && vscode.commands.executeCommand('i18nSync.showStatus'));
}

function noticePending(count: number) {
	void vscode.window
		.showWarningMessage(
			`${NAME}: ${count} string(s) could not be translated yet (translation services unavailable). English was written for now; they will be retried automatically.`,
			'Show log',
		)
		.then((p) => p && out.show());
}

/** Progress notification whose message counts translated strings. */
function withTranslationProgress<T>(title: string, run: (makeService: (expected: number) => ReturnType<Runtime['buildService']>) => Promise<T>): Thenable<T> {
	return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, (progress) => {
		let n = 0;
		let expected = 0;
		return run((e) => {
			expected = e;
			const s = readSettings();
			return rt.buildService(s, e, () => progress.report({ message: `translated ${++n} of ~${expected} strings` }));
		});
	});
}

/** Forward flow: a commit in the SourceRepo is synced into the DestinationRepo. */
async function runSync(api: GitAPI, repo: GitRepo, from: string, to: string, manual: boolean) {
	const s = readSettings();
	const entry = { root: repo.rootUri.fsPath, from, to };
	await journal.start(entry);
	try {
		const stats = await withTranslationProgress(`${NAME}: ${to.slice(0, 7)}`, (makeService) =>
			syncCommit(s.cfg, { makeService, pending: pendingStore, snapshots }, api.git.path, repo.rootUri.fsPath, from, to, log),
		);
		await journal.finish(entry);
		log(`done: ${stats.files} file(s) written, ${stats.verified} key(s) verified on disk, ${stats.pending} pending, ${stats.machine} machine-translated, ${stats.skipped} already up to date`);
		recordRun(undefined, stats.issues.length);
		noticeMachine(stats.machine, s);
		if (stats.issues.length) {
			noticeIssues(stats.issues.length);
		} else if (stats.pending) {
			noticePending(stats.pending);
		} else if (stats.files || manual) {
			const msg = stats.files
				? `${NAME}: updated ${stats.files} file(s) in the DestinationRepo` + (stats.created ? ` (${stats.created} newly created).` : '.')
				: `${NAME}: no locale key changes to sync.`;
			// don't await: an unanswered toast must not hold up the sync of the next commit
			void vscode.window.showInformationMessage(msg, 'Show log').then((pick) => pick && out.show());
		}
	} catch (e) {
		// the journal entry stays, so this commit is tried again the next time VS Code starts
		log(`ERROR ${(e as Error).stack ?? e}`);
		recordRun((e as Error).message);
		vscode.window.showErrorMessage(`${NAME} failed: ${(e as Error).message}`, 'Show log').then((p) => p && out.show());
	}
}

/** State-based flow (the Sync Locales button): new and edited strings of the source folder go to the destinations chosen for this batch. */
async function runSourceSync(api: GitAPI): Promise<void> {
	const s = readSettings();
	if (s.cfg.sourceDir && s.allDestinations.length && !s.cfg.destinations.length) {
		void vscode.window.showInformationMessage(`${NAME}: no destination is ticked, so there is nothing to do.`, 'Open settings').then((p) => p && vscode.commands.executeCommand('i18nSync.configure'));
		return;
	}
	if (!s.configured) {
		void vscode.window.showWarningMessage(`${NAME} is not configured yet.`, 'Set up').then((p) => p && void vscode.commands.executeCommand('i18nSync.configure'));
		return;
	}
	const chosen = await chooseDestinations(s);
	if (!chosen) {
		return;
	}
	if (!chosen.length) {
		void vscode.window.showInformationMessage(`${NAME}: no destination was chosen, so nothing was synced.`);
		return;
	}
	try {
		const res = await withTranslationProgress(`${NAME}: syncing locales`, (makeService) =>
			syncFromSource({ ...s.cfg, destinations: chosen }, { makeService, pending: pendingStore, snapshots }, api.git.path, log),
		);
		const st = res.stats;
		log(`done: ${st.files} file(s) written, ${st.verified} key(s) verified, ${st.pending} pending, ${st.machine} machine-translated`);
		recordRun(undefined, st.issues.length);
		noticeMachine(st.machine, s);
		if (st.issues.length) {
			noticeIssues(st.issues.length);
			return;
		}
		if (st.pending) {
			noticePending(st.pending);
			return;
		}
		const where = chosen.map((d) => path.basename(d.path) || d.path).join(', ');
		void vscode.window.showInformationMessage(st.files ? `${NAME}: updated ${st.files} file(s) in ${where}.` : `${NAME}: ${where} is already in sync with ${s.cfg.sourceLocale}.`, 'Show log').then((p) => p && out.show());
	} catch (e) {
		log(`ERROR ${(e as Error).stack ?? e}`);
		recordRun((e as Error).message);
		vscode.window.showErrorMessage(`${NAME} failed: ${(e as Error).message}`, 'Show log').then((p) => p && out.show());
	}
}

let retrying = false;
/** Re-translate strings that were written in English (or by machine translation) while no good translator was reachable. */
async function retryPendingNow(manual: boolean) {
	if (retrying) {
		return;
	}
	const before = await pendingStore.count();
	if (!before) {
		if (manual) {
			void vscode.window.showInformationMessage(`${NAME}: nothing pending.`);
		}
		return;
	}
	retrying = true;
	try {
		const s = readSettings();
		const service = await rt.buildService({ ...s, budgetMs: 10 * 60_000 }, before);
		const r = await retryPending(pendingStore, service, log);
		log(`pending retry: ${r.fixed} translated, ${r.dropped} dropped (edited or removed meanwhile), ${r.remaining} still pending`);
		if (r.fixed || manual) {
			void vscode.window.showInformationMessage(`${NAME}: ${r.fixed} pending string(s) translated` + (r.remaining ? `, ${r.remaining} still waiting.` : '.'));
		}
	} catch (e) {
		log(`ERROR retrying pending: ${(e as Error).message}`);
	} finally {
		retrying = false;
		refreshStatus();
	}
}

/**
 * The Git extension only notices commits made in a terminal when its own file watcher fires, which can lag or miss.
 * Watching .git/logs/HEAD ourselves (git appends to it on every commit/checkout/pull) and asking for a refresh makes it reliable.
 */
function forceRefreshOnGitActivity(repo: GitRepo, ctx: vscode.ExtensionContext) {
	const logFile = path.join(repo.rootUri.fsPath, '.git', 'logs', 'HEAD');
	if (!fs.existsSync(logFile)) {
		return; // worktree/submodule (.git is a file) or no commits yet: rely on the Git extension alone
	}
	let timer: NodeJS.Timeout | undefined;
	try {
		const w = fs.watch(logFile, () => {
			clearTimeout(timer);
			timer = setTimeout(() => void repo.status().catch(() => undefined), 300);
		});
		ctx.subscriptions.push({ dispose: () => (clearTimeout(timer), w.close()) });
	} catch (e) {
		log(`could not watch ${logFile}: ${(e as Error).message}`);
	}
}

function watchRepo(api: GitAPI, repo: GitRepo, ctx: vscode.ExtensionContext) {
	let last = repo.state.HEAD?.commit;
	let lastBranch = repo.state.HEAD?.name;
	if (!last) {
		// the repo's first status may not have loaded yet; without a baseline the first commit would be missed
		void Promise.all([
			git(api.git.path, repo.rootUri.fsPath, ['rev-parse', 'HEAD']),
			git(api.git.path, repo.rootUri.fsPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
		])
			.then(([h, b]) => {
				last ??= h.trim();
				lastBranch ??= b.trim();
			})
			.catch(() => undefined);
	}
	forceRefreshOnGitActivity(repo, ctx);

	ctx.subscriptions.push(
		repo.state.onDidChange(async () => {
			const head = repo.state.HEAD?.commit;
			const branch = repo.state.HEAD?.name;
			const prev = last;
			const prevBranch = lastBranch;
			last = head;
			lastBranch = branch;
			if (!head || !prev || head === prev || branch !== prevBranch) {
				return; // no move, first sight, or a branch switch
			}

			const s = readSettings();
			if (!s.enabled || !s.configured || !ownsSource(repo, s.cfg.sourceDir)) {
				return;
			}
			const root = repo.rootUri.fsPath;
			if (['rebase-merge', 'rebase-apply', 'MERGE_HEAD'].some((f) => fs.existsSync(path.join(root, '.git', f)))) {
				log(`skip ${head.slice(0, 7)}: rebase/merge in progress`);
				return;
			}
			try {
				const info = await getCommitInfo(api.git.path, root, head);
				if (info.parents.length !== 1) {
					log(`skip ${head.slice(0, 7)}: merge or root commit`);
					return;
				}
				if (info.parents[0] !== prev) {
					log(`skip ${head.slice(0, 7)}: not a single new commit on top of previous HEAD (pull/rebase/amend)`);
					return;
				}
				if (s.onlyOwnCommits) {
					const me = await getUserEmail(api.git.path, root);
					if (me && info.authorEmail.toLowerCase() !== me.toLowerCase()) {
						log(`skip ${head.slice(0, 7)}: authored by ${info.authorEmail}, not you`);
						return;
					}
				}
			} catch (e) {
				log(`ERROR inspecting ${head.slice(0, 7)}: ${(e as Error).message}`);
				return;
			}
			log(`commit ${head.slice(0, 7)} detected`);
			queue = queue.then(() => runSync(api, repo, prev, head, false));
		}),
	);
}

export async function activate(ctx: vscode.ExtensionContext) {
	out = vscode.window.createOutputChannel(NAME);
	ctx.subscriptions.push(out);
	storageDir = ctx.globalStorageUri.fsPath;
	pendingStore = new PendingStore(path.join(storageDir, 'pending.json'));
	journal = new Journal(ctx.globalState);
	state = ctx.globalState;
	snapshots = new SnapshotStore(path.join(storageDir, 'snapshot.json'));
	rt = new Runtime(ctx.secrets, log, () => pendingStore, ctx.globalState);

	const gitExt = vscode.extensions.getExtension<{ getAPI(v: 1): GitAPI }>('vscode.git');
	if (!gitExt) {
		vscode.window.showErrorMessage(`${NAME} needs the built-in Git extension, which is disabled.`);
		return;
	}
	const api = (await gitExt.activate()).getAPI(1);
	const watched = new Set<string>();
	const add = (r: GitRepo) => {
		if (!watched.has(r.rootUri.fsPath)) {
			watched.add(r.rootUri.fsPath);
			watchRepo(api, r, ctx);
			log(`watching ${r.rootUri.fsPath}`);
		}
	};
	api.repositories.forEach(add);
	ctx.subscriptions.push(api.onDidOpenRepository(add));

	// status bar: state of the sync, and a button to translate whatever is new in the DestinationRepo
	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1);
	const syncButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 0);
	syncButton.text = '$(globe) Sync Locales';
	syncButton.tooltip = 'Sync new and edited strings of the source folder to the ticked destinations';
	syncButton.command = 'i18nSync.syncDestination';
	ctx.subscriptions.push(status, syncButton);
	refreshStatus = () => {
		const s = readSettings();
		void pendingStore.count().then((n) => {
			if (!s.configured) {
				status.text = '$(warning) i18n Sync: set up';
				status.tooltip = `${NAME} is not configured yet. Click to set it up.`;
				status.command = 'i18nSync.configure';
				syncButton.hide();
			} else if (n > 0 || lastIssues > 0) {
				status.text = `$(warning) i18n Sync: ${[n ? `${n} pending` : '', lastIssues ? `${lastIssues} problem(s)` : ''].filter(Boolean).join(', ')}`;
				status.tooltip = `${n ? `${n} string(s) are in English or machine-translated because no good translator was reachable; they are retried automatically. ` : ''}${lastIssues ? `${lastIssues} file(s) or key(s) could not be synced because their content is broken. ` : ''}Click to see what and why.`;
				status.command = 'i18nSync.showStatus';
				syncButton.show();
			} else {
				status.text = s.enabled ? '$(sync) i18n Sync' : '$(circle-slash) i18n Sync off';
				status.tooltip = `${NAME} settings`;
				status.command = 'i18nSync.configure';
				syncButton.show();
			}
			status.show();
		});
		refreshStatusPanel();
	};
	refreshStatus();
	/** after the settings screen saves, and when a folder setting is edited by hand */
	const afterSave = () => {
		refreshStatus();
		void rt.refreshProfile(readSettings());
		void retryPendingNow(false); // a new provider or key may be able to finish strings that were waiting
	};
	const configDeps: ConfigDeps = {
		using: () => rt.usingNow(readSettings()),
		keysSaved: async () => ({
			gemini: !!(await ctx.secrets.get(keySlot('gemini'))),
			groq: !!(await ctx.secrets.get(keySlot('groq'))),
			custom: !!(await ctx.secrets.get(keySlot('custom'))),
		}),
		storeKey: (provider, key) => Promise.resolve(ctx.secrets.store(keySlot(provider), key)),
		ollamaModels: (address) => listOllamaModels(address),
	};
	ctx.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('i18nSync')) {
				refreshStatus();
			}
			if (e.affectsConfiguration('i18nSync.destinations') || e.affectsConfiguration('i18nSync.source')) {
				void rt.refreshProfile(readSettings());
			}
		}),
	);
	if (!isConfigured() && !ctx.globalState.get('setupDeclined')) {
		vscode.window
			.showInformationMessage(`${NAME} needs to know where your source and destination repos are.`, 'Set up', 'Not now', "Don't ask again")
			.then((p) => {
				if (p === 'Set up') {
					openConfigPanel(ctx, afterSave, configDeps);
				} else if (p === "Don't ask again") {
					ctx.globalState.update('setupDeclined', true);
				}
			});
	}

	ctx.subscriptions.push(
		vscode.commands.registerCommand('i18nSync.configure', () => openConfigPanel(ctx, afterSave, configDeps)),
		vscode.commands.registerCommand('i18nSync.syncLastCommit', async () => {
			const s = readSettings();
			if (!s.configured) {
				vscode.window.showWarningMessage(`${NAME} is not configured yet.`, 'Set up').then((p) => p && openConfigPanel(ctx, afterSave, configDeps));
				return;
			}
			const repo = api.repositories.find((r) => ownsSource(r, s.cfg.sourceDir));
			const head = repo?.state.HEAD?.commit;
			if (!repo || !head) {
				vscode.window.showWarningMessage(`${NAME}: no open Git repo contains i18nSync.source.`);
				return;
			}
			const info = await getCommitInfo(api.git.path, repo.rootUri.fsPath, head);
			if (info.parents.length < 1) {
				return;
			}
			log(`manual sync of ${head.slice(0, 7)}`);
			queue = queue.then(() => runSync(api, repo, info.parents[0], head, true));
		}),
		vscode.commands.registerCommand('i18nSync.syncDestination', () => {
			queue = queue.then(() => runSourceSync(api));
		}),
		vscode.commands.registerCommand('i18nSync.showLog', () => out.show()),
		vscode.commands.registerCommand('i18nSync.retryPending', () => retryPendingNow(true)),
		vscode.commands.registerCommand('i18nSync.showStatus', () => {
			openStatusPanel(ctx, {
				pending: pendingStore,
				roots: () => readSettings().allDestinations.map((d) => d.path),
				configured: () => readSettings().configured,
				syncsLocales: () => readSettings().cfg.destinations.some((d) => d.mode === 'translate'),
				scan: () => {
					const s = readSettings();
					return scanSource(s.cfg, { snapshots }, api.git.path, log);
				},
				lastError: () => state.get<{ at: number; message: string } | undefined>(LAST_ERROR, undefined),
				syncLocales: () => {
					const run = queue.then(() => runSourceSync(api));
					queue = run;
					return run;
				},
				retryPending: () => retryPendingNow(true),
			});
		}),
		vscode.commands.registerCommand('i18nSync.copyAiPrompt', async () => {
			const s = readSettings();
			const built = await buildManualPrompt(pendingStore, s.localesDir, s.cfg.sourceLocale, await rt.loadContext(s));
			if (!built) {
				void vscode.window.showInformationMessage(`${NAME}: nothing is waiting for a better translation.`);
				return;
			}
			await ctx.globalState.update('awaitingAi', built.awaiting);
			await vscode.env.clipboard.writeText(built.prompt);
			const n = built.awaiting.items.length;
			const more = built.remaining ? ` ${built.remaining} more string(s) will follow in the next prompt.` : '';
			const pick = await vscode.window.showInformationMessage(
				`Prompt for ${n} ${built.awaiting.locale} string(s) copied. Paste it into your AI chat, copy the whole reply, then choose "Apply answer".${more}`,
				'Apply answer',
			);
			if (pick) {
				void vscode.commands.executeCommand('i18nSync.applyAiAnswer');
			}
		}),
		vscode.commands.registerCommand('i18nSync.applyAiAnswer', async () => {
			const awaiting = ctx.globalState.get<Awaiting>('awaitingAi');
			if (!awaiting) {
				void vscode.window.showWarningMessage(`${NAME}: copy a prompt first ("Improve with my AI chat").`);
				return;
			}
			const s = readSettings();
			const result = await applyManualAnswer(pendingStore, awaiting, await vscode.env.clipboard.readText(), await rt.loadContext(s));
			if (!result) {
				void vscode.window.showErrorMessage(`${NAME}: the clipboard does not contain a JSON reply. Copy the whole answer of the AI chat and try again.`);
				return;
			}
			await ctx.globalState.update('awaitingAi', undefined);
			refreshStatus();
			for (const r of result.rejected) {
				log(`rejected AI answer for "${r.text}": ${r.problems.join('; ')} (reply was: ${r.reply})`);
			}
			const left = await pendingStore.count();
			const parts = [`${result.applied} translation(s) written`];
			if (result.rejected.length) {
				parts.push(`${result.rejected.length} rejected by the checks (placeholders / script / terms), see the log`);
			}
			if (result.missing) {
				parts.push(`${result.missing} missing from the reply`);
			}
			const pick = await vscode.window.showInformationMessage(`${NAME}: ${parts.join(', ')}.${left ? ` ${left} still waiting.` : ''}`, ...(left ? ['Copy next prompt'] : []));
			if (pick) {
				void vscode.commands.executeCommand('i18nSync.copyAiPrompt');
			}
		}),
		vscode.commands.registerCommand('i18nSync.testAi', () => testAi(rt, log, out)),
		vscode.commands.registerCommand('i18nSync.qualityCheck', () => qualityCheck(rt, log)),
		vscode.commands.registerCommand('i18nSync.setApiKey', () => setApiKey(ctx.secrets)),
		vscode.commands.registerCommand('i18nSync.createContextTemplate', async () => {
			const file = await createContextTemplate(readSettings());
			if (file) {
				refreshStatus();
			}
		}),
		vscode.commands.registerCommand('i18nSync.openContextFile', async () => {
			const file = contextPath(readSettings());
			if (!file) {
				const pick = await vscode.window.showInformationMessage('No context file is set up yet.', 'Create from template');
				if (pick) {
					void vscode.commands.executeCommand('i18nSync.createContextTemplate');
				}
				return;
			}
			await vscode.window.showTextDocument(vscode.Uri.file(file));
		}),
	);

	// finish anything a previous session left half-done, and keep retrying strings that are still in English
	setTimeout(async () => {
		for (const e of await journal.takeForReplay()) {
			const repo = api.repositories.find((r) => r.rootUri.fsPath === e.root);
			if (repo) {
				log(`resuming interrupted sync of ${e.to.slice(0, 7)}`);
				queue = queue.then(() => runSync(api, repo, e.from, e.to, false));
			}
		}
		queue = queue.then(() => retryPendingNow(false));
	}, 10_000);
	const timer = setInterval(() => (queue = queue.then(() => retryPendingNow(false))), 5 * 60_000);
	ctx.subscriptions.push({ dispose: () => clearInterval(timer) });
	log(`${NAME} active`);
}

export function deactivate() {}
