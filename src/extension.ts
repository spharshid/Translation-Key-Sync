import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { isConfigured, openConfigPanel } from './configPanel';
import { git, getCommitInfo, getUserEmail } from './git';
import { Journal } from './journal';
import { PendingStore, retryPending } from './pending';
import { syncCommit, SyncConfig } from './syncCommit';
import { ProviderHealth, Translator } from './translator';

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

let out: vscode.OutputChannel;
const log = (m: string) => out.appendLine(`${new Date().toLocaleTimeString()} ${m}`);

function readConfig() {
	const c = vscode.workspace.getConfiguration('localeSync');
	const cfg: SyncConfig = {
		sourceDir: path.normalize(c.get<string>('sourceDir', '')),
		targetDir: path.normalize(c.get<string>('targetDir', '')),
		locales: c.get<string[]>('locales', []),
		sourceLocale: c.get<string>('sourceLocale', 'en'),
	};
	return {
		cfg,
		configured: !!c.get<string>('sourceDir') && !!c.get<string>('targetDir') && cfg.locales.length > 0,
		enabled: c.get<boolean>('enabled', true),
		onlyOwnCommits: c.get<boolean>('onlyOwnCommits', true),
		backendUrl: c.get<string>('backendUrl', ''),
		backendTimeoutMs: c.get<number>('backendTimeoutSeconds', 60) * 1000,
		provider: c.get<'auto' | 'backend' | 'google'>('provider', 'auto'),
		googleUrl: c.get<string>('googleUrl', ''),
		budgetMs: c.get<number>('maxWaitMinutes', 5) * 60_000,
	};
}

/** Does this repo contain the configured source dir? */
function ownsSource(repo: GitRepo, sourceDir: string) {
	const rel = path.relative(repo.rootUri.fsPath, sourceDir);
	return !!sourceDir && !rel.startsWith('..') && !path.isAbsolute(rel);
}

let queue: Promise<unknown> = Promise.resolve();

// shared by every run so a backend we already woke up (or a Google that is rate limiting us) is remembered
const health = new ProviderHealth();
let pendingStore: PendingStore;
let journal: Journal;
let refreshStatus: () => void = () => undefined;

function newTranslator(s: ReturnType<typeof readConfig>, expectedStrings: number, onTranslated?: () => void, budgetMs = s.budgetMs) {
	return new Translator(
		{
			backendUrl: s.backendUrl,
			googleUrl: s.googleUrl || undefined,
			backendTimeoutMs: s.backendTimeoutMs,
			provider: s.provider,
			expectedStrings,
			budgetMs,
			log,
			onTranslated,
		},
		s.cfg.sourceLocale,
		health,
	);
}

async function runSync(api: GitAPI, repo: GitRepo, from: string, to: string, manual: boolean) {
	const s = readConfig();
	const entry = { root: repo.rootUri.fsPath, from, to };
	await journal.start(entry);
	try {
		const stats = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: `Translation Key Sync: ${to.slice(0, 7)}` },
			(progress) => {
				let n = 0;
				let expected = 0;
				const makeTranslator = (expectedStrings: number) => {
					expected = expectedStrings;
					return newTranslator(s, expectedStrings, () => progress.report({ message: `translated ${++n} of ~${expected} strings` }));
				};
				return syncCommit(s.cfg, { makeTranslator, pending: pendingStore }, api.git.path, repo.rootUri.fsPath, from, to, log);
			},
		);
		await journal.finish(entry);
		log(`done: ${stats.files} file(s) written, ${stats.verified} key(s) verified on disk, ${stats.pending} pending`);
		refreshStatus();
		if (stats.pending) {
			void vscode.window
				.showWarningMessage(
					`Translation Key Sync: ${stats.pending} string(s) could not be translated yet (translation services unavailable). English was written for now; they will be retried automatically.`,
					'Show log',
				)
				.then((p) => p && out.show());
		} else if (stats.files || manual) {
			const msg = stats.files
				? `Translation Key Sync: updated ${stats.files} file(s) in the translation repo` + (stats.created ? ` (${stats.created} newly created).` : '.')
				: 'Translation Key Sync: no locale key changes to sync.';
			// don't await: an unanswered toast must not hold up the sync of the next commit
			void vscode.window.showInformationMessage(msg, 'Show log').then((pick) => pick && out.show());
		}
	} catch (e) {
		// the journal entry stays, so this commit is tried again the next time VS Code starts
		log(`ERROR ${(e as Error).stack ?? e}`);
		vscode.window
			.showErrorMessage(`Translation Key Sync failed: ${(e as Error).message}`, 'Show log')
			.then((p) => p && out.show());
	}
}

let retrying = false;
/** Re-translate strings that were written in English because every provider was down at the time. */
async function retryPendingNow(manual: boolean) {
	if (retrying) {
		return;
	}
	const before = await pendingStore.count();
	if (!before) {
		if (manual) {
			void vscode.window.showInformationMessage('Translation Key Sync: nothing pending.');
		}
		return;
	}
	retrying = true;
	try {
		const s = readConfig();
		const translator = newTranslator(s, before, undefined, 10 * 60_000);
		await translator.prepare();
		const r = await retryPending(pendingStore, translator, log);
		log(`pending retry: ${r.fixed} translated, ${r.dropped} dropped (edited or removed meanwhile), ${r.remaining} still pending`);
		if (r.fixed || manual) {
			void vscode.window.showInformationMessage(
				`Translation Key Sync: ${r.fixed} pending string(s) translated` + (r.remaining ? `, ${r.remaining} still waiting.` : '.'),
			);
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

			const s = readConfig();
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
	out = vscode.window.createOutputChannel('Translation Key Sync');
	ctx.subscriptions.push(out);
	pendingStore = new PendingStore(path.join(ctx.globalStorageUri.fsPath, 'pending.json'));
	journal = new Journal(ctx.globalState);

	const gitExt = vscode.extensions.getExtension<{ getAPI(v: 1): GitAPI }>('vscode.git');
	if (!gitExt) {
		vscode.window.showErrorMessage('Translation Key Sync needs the built-in Git extension, which is disabled.');
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

	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 0);
	status.command = 'localeSync.configure';
	ctx.subscriptions.push(status);
	refreshStatus = () => {
		const s = readConfig();
		void pendingStore.count().then((n) => {
			if (!s.configured) {
				status.text = '$(warning) Key Sync: set up';
				status.tooltip = 'Translation Key Sync is not configured yet. Click to set it up.';
			} else if (n > 0) {
				status.text = `$(warning) Key Sync: ${n} pending`;
				status.tooltip = `${n} string(s) are in English because translation was unavailable. They are retried automatically.`;
				status.command = 'localeSync.retryPending';
			} else {
				status.text = s.enabled ? '$(sync) Key Sync' : '$(circle-slash) Key Sync off';
				status.tooltip = 'Translation Key Sync settings';
				status.command = 'localeSync.configure';
			}
			status.show();
		});
	};
	refreshStatus();
	ctx.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('localeSync') && refreshStatus()),
	);
	if (!isConfigured() && !ctx.globalState.get('setupDeclined')) {
		vscode.window
			.showInformationMessage('Translation Key Sync needs to know where your FE and translation repos are.', 'Set up', 'Not now', "Don't ask again")
			.then((p) => {
				if (p === 'Set up') {
					openConfigPanel(ctx, refreshStatus);
				} else if (p === "Don't ask again") {
					ctx.globalState.update('setupDeclined', true);
				}
			});
	}

	ctx.subscriptions.push(
		vscode.commands.registerCommand('localeSync.configure', () => openConfigPanel(ctx, refreshStatus)),
		vscode.commands.registerCommand('localeSync.syncLastCommit', async () => {
			const s = readConfig();
			if (!s.configured) {
				vscode.window
					.showWarningMessage('Translation Key Sync is not configured yet.', 'Set up')
					.then((p) => p && openConfigPanel(ctx, refreshStatus));
				return;
			}
			const repo = api.repositories.find((r) => ownsSource(r, s.cfg.sourceDir));
			const head = repo?.state.HEAD?.commit;
			if (!repo || !head) {
				vscode.window.showWarningMessage('Translation Key Sync: no open Git repo contains localeSync.sourceDir.');
				return;
			}
			const info = await getCommitInfo(api.git.path, repo.rootUri.fsPath, head);
			if (info.parents.length < 1) {
				return;
			}
			log(`manual sync of ${head.slice(0, 7)}`);
			queue = queue.then(() => runSync(api, repo, info.parents[0], head, true));
		}),
		vscode.commands.registerCommand('localeSync.showLog', () => out.show()),
		vscode.commands.registerCommand('localeSync.retryPending', () => retryPendingNow(true)),
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
	log('Translation Key Sync active');
}

export function deactivate() {}
