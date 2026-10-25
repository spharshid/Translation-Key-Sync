// Runs INSIDE the VS Code extension host, against the real extension build.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execSync } = require('child_process');

const SRC_REPO = process.env.TKS_SRC_REPO;
const DST_REPO = process.env.TKS_DST_REPO;
const OUT = process.env.TKS_OUT;
const SRC = path.join(SRC_REPO, 'locales', 'en');
const DST = path.join(DST_REPO, 'locales');
const sh = (c, cwd = SRC_REPO) => execSync(c, { cwd, stdio: 'pipe' }).toString().trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rd = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
const es = (rel) => {
	const t = rd(path.join(DST, 'es', rel));
	return t ? JSON.parse(t) : null;
};
const log = (m) => fs.appendFileSync(OUT, m + '\n');
const results = [];
/** what the stub AI answers: always different from the English so the validator accepts it as a translation */
const AI = (t) => 'ai(' + t.replace(/[aeiou]/g, 'x') + ')';

async function until(cond, ms = 60000, step = 500) {
	const t = Date.now();
	while (Date.now() - t < ms) {
		if (await cond()) {return true;}
		await sleep(step);
	}
	return false;
}
async function check(name, fn) {
	try {
		await fn();
		results.push('PASS  ' + name);
		log('PASS  ' + name);
	} catch (e) {
		results.push('FAIL  ' + name + ' :: ' + e.message);
		log('FAIL  ' + name + ' :: ' + e.message);
		try {
			log('   git: ' + sh('git log --oneline --graph --all -8').split('\n').join(' | '));
		} catch {}
	}
}
const writeJson = (dir, rel, obj) => {
	fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
	fs.writeFileSync(path.join(dir, rel), JSON.stringify(obj, null, 2).replace(/\n/g, '\r\n') + '\r\n');
};
const commit = (msg, author) => {
	sh('git add -A');
	sh(`git commit -q -m "${msg}"${author ? ` --author="${author}"` : ''}`);
};

exports.run = async function run() {
	fs.writeFileSync(OUT, '');

	// stand-in for an OpenAI-compatible AI endpoint: translates every string as ai(<text>) and remembers the last prompt
	let aiMode = 'ok';
	const prompts = [];
	const aiServer = http.createServer((req, res) => {
		let b = '';
		req.on('data', (c) => (b += c));
		req.on('end', () => {
			if (aiMode !== 'ok') {
				res.statusCode = 503;
				return res.end('down');
			}
			const prompt = JSON.parse(b).messages[0].content;
			prompts.push(prompt);
			const items = prompt.split('\n').filter((l) => l.startsWith('{"id":')).map((l) => JSON.parse(l));
			const answer = JSON.stringify(Object.fromEntries(items.map((i) => [i.id, AI(i.text)])));
			res.setHeader('Content-Type', 'application/json');
			res.end(JSON.stringify({ choices: [{ message: { content: answer } }] }));
		});
	});
	await new Promise((r) => aiServer.listen(0, '127.0.0.1', r));
	const aiUrl = `http://127.0.0.1:${aiServer.address().port}/v1`;

	// stand-in for Google (the machine-translation fallback)
	let gMode = 'ok';
	const gServer = http.createServer((req, res) => {
		const u = new URL(req.url, 'http://x');
		if (gMode !== 'ok') {
			res.statusCode = 429;
			return res.end('<html>Sorry</html>');
		}
		res.setHeader('Content-Type', 'application/json');
		res.end(JSON.stringify([[[`g|${u.searchParams.get('tl')}|${u.searchParams.get('q')}`, u.searchParams.get('q')]]]));
	});
	await new Promise((r) => gServer.listen(0, '127.0.0.1', r));
	const gUrl = `http://127.0.0.1:${gServer.address().port}/translate_a/single`;

	const ext = vscode.extensions.getExtension('spharshid.i18n-ai-translate-sync');
	if (!ext) {throw new Error('extension not found in host');}
	await ext.activate();
	log('extension active: ' + ext.isActive);

	const cfg = vscode.workspace.getConfiguration('i18nSync');
	const G = vscode.ConfigurationTarget.Global;
	const set = async (obj) => {
		for (const [k, v] of Object.entries(obj)) {await cfg.update(k, v, G);}
		await sleep(800);
	};
	await set({
		source: SRC,
		destinations: [{ path: DST, mode: 'translate', enabled: true }],
		askDestinations: false,
		locales: ['en', 'es'],
		googleUrl: gUrl,
		provider: 'google',
		'ai.enabled': true,
		'ai.provider': 'custom',
		'ai.endpoint': aiUrl,
		'ai.model': 'stub-model',
		'ai.reviewPass': false,
		'ai.allowFreeFallbacks': false, // keep the integration run offline and deterministic
		maxWaitMinutes: 1,
	});

	const git = vscode.extensions.getExtension('vscode.git').exports.getAPI(1);
	await check('Git extension sees the SourceRepo', async () => {
		if (!(await until(() => git.repositories.length > 0, 20000))) {throw new Error('no repository discovered');}
	});
	const repo = git.repositories[0];
	await sleep(1500);

	await check('every command is registered', async () => {
		const cmds = await vscode.commands.getCommands(true);
		for (const c of ['configure', 'syncLastCommit', 'syncDestination', 'showLog', 'retryPending', 'testAi', 'qualityCheck', 'setApiKey', 'createContextTemplate', 'openContextFile', 'showStatus']) {
			if (!cmds.includes('i18nSync.' + c)) {throw new Error('missing command i18nSync.' + c);}
		}
	});

	// ---- forward flow: commit in the SourceRepo
	await check('terminal commit is translated by the AI model, with key path and approved translations in the prompt', async () => {
		writeJson(SRC, 'common.json', { save: 'Save', fresh: 'Fresh key', nested: { a: 'A', b: 'B2' } });
		commit('t1');
		if (!(await until(() => es('common.json')?.fresh))) {throw new Error('es/common.json never got the new key: ' + rd(path.join(DST, 'es', 'common.json')));}
		const j = es('common.json');
		if (j.fresh !== AI('Fresh key')) {throw new Error('not translated by the AI: ' + j.fresh);}
		if (j.nested.b !== AI('B2')) {throw new Error('nested change missing');}
		if ('gone' in j) {throw new Error('deleted key still present');}
		const p = prompts.find((x) => x.includes('Fresh key'));
		if (!p || !p.includes('"key":"fresh"')) {throw new Error('prompt lacks the key path');}
		if (!/Reference translations/.test(p)) {throw new Error('prompt lacks reference translations');}
		if (/[^\r]\n/.test(rd(path.join(DST, 'es', 'common.json')))) {throw new Error('CRLF lost');}
	});

	await check('commit by another author is skipped', async () => {
		writeJson(SRC, 'common.json', { save: 'Save', fresh: 'Fresh key', nested: { a: 'A', b: 'B2' }, bycolleague: 'Colleague' });
		commit('t2', 'Colleague <c@c.com>');
		await sleep(9000);
		if (es('common.json').bycolleague) {throw new Error('synced a colleague commit');}
	});

	await check('merge commit is skipped', async () => {
		const main = sh('git rev-parse --abbrev-ref HEAD');
		sh('git checkout -q -b feat');
		writeJson(SRC, 'common.json', { save: 'Save', fresh: 'Fresh key', nested: { a: 'A', b: 'B2' }, bycolleague: 'Colleague', featkey: 'Feature key' });
		commit('feat work', 'Colleague <c@c.com>');
		sh(`git checkout -q ${main}`);
		writeJson(SRC, 'other.json', { o: 'Other', ctl: 'Control' });
		commit('main work');
		if (!(await until(() => es('other.json')?.ctl))) {throw new Error('control commit did not sync (listener dead?)');}
		sh('git merge --no-ff -q -m "merge feat" feat');
		await sleep(9000);
		if (es('common.json').featkey) {throw new Error('merge commit was synced');}
	});

	await check('amend is skipped', async () => {
		writeJson(SRC, 'other.json', { o: 'Other', ctl: 'Control', amended: 'Amended key' });
		sh('git add -A');
		sh('git commit -q --amend --no-edit');
		await sleep(9000);
		if (es('other.json').amended) {throw new Error('amend was synced');}
	});

	await check('new file in a sub-folder is created with all strings', async () => {
		writeJson(SRC, 'dev/brandnew.json', { title: 'Dashboard', grp: { a: 'Alpha', b: 'Beta' } });
		commit('t5');
		if (!(await until(() => es('dev/brandnew.json')))) {throw new Error('file not created');}
		const j = es('dev/brandnew.json');
		if (j.title !== AI('Dashboard') || j.grp.b !== AI('Beta')) {throw new Error('contents wrong: ' + JSON.stringify(j));}
	});

	await check('branch switch does not sync', async () => {
		sh('git checkout -q -b scratch');
		sh('git checkout -q -');
		await sleep(4000);
	});

	await check('commit from the VS Code Source Control UI syncs', async () => {
		writeJson(SRC, 'other.json', { o: 'Other', ctl: 'Control', viaui: 'From the UI' });
		await repo.status();
		repo.inputBox.value = 'ui commit';
		await vscode.commands.executeCommand('git.stageAll', repo.rootUri);
		await vscode.commands.executeCommand('git.commit', repo.rootUri);
		if (!(await until(() => es('other.json')?.viaui))) {throw new Error('UI commit did not sync; HEAD msg=' + sh('git log -1 --format=%s'));}
	});

	await check('enabled=false stops syncing', async () => {
		await set({ enabled: false });
		writeJson(SRC, 'other.json', { o: 'Other', ctl: 'Control', viaui: 'From the UI', off: 'Should not sync' });
		commit('t8');
		await sleep(9000);
		if (es('other.json').off) {throw new Error('synced while disabled');}
		await set({ enabled: true });
	});

	// ---- the AI endpoint is down and Google is blocked: nothing may be lost
	await check('AI and machine translation both down: key written in English and queued; Retry Pending heals it once the AI is back', async () => {
		aiMode = 'down';
		gMode = 'down';
		writeJson(SRC, 'other.json', { o: 'Other', ctl: 'Control', viaui: 'From the UI', off: 'Should not sync', resilient: 'Resilient string' });
		commit('t9');
		if (!(await until(() => es('other.json')?.resilient, 120000))) {throw new Error('key never written while services were down');}
		if (es('other.json').resilient !== 'Resilient string') {throw new Error('expected the English placeholder, got ' + es('other.json').resilient);}
		aiMode = 'ok';
		gMode = 'ok';
		await vscode.commands.executeCommand('i18nSync.retryPending');
		if (!(await until(() => es('other.json').resilient === AI('Resilient string'), 90000))) {throw new Error('not healed: ' + es('other.json').resilient);}
	});

	// ---- translation-repo-first flow
	await check('Sync Locales: English added in the DestinationRepo is translated into the other locales', async () => {
		await set({ source: path.join(DST, 'en') }); // from here on the base language inside the translation repo is the source
		fs.writeFileSync(path.join(DST, 'en', 'common.json'), JSON.stringify({ ...JSON.parse(rd(path.join(DST, 'en', 'common.json'))), devadded: 'Added in the translation repo' }, null, 2) + '\r\n');
		await vscode.commands.executeCommand('i18nSync.syncDestination');
		if (!(await until(() => es('common.json')?.devadded === AI('Added in the translation repo'), 90000))) {throw new Error('not translated: ' + es('common.json')?.devadded);}
		const srcFallback = JSON.parse(rd(path.join(SRC, 'common.json')));
		if ('devadded' in srcFallback) {throw new Error('the fallback was written although it is not a destination');}
	});

	await check('Sync Locales with the SourceRepo folder as a "copy" destination also writes the English into it', async () => {
		await set({ destinations: [{ path: DST, mode: 'translate', enabled: true }, { path: SRC, mode: 'copy', enabled: true }] });
		fs.writeFileSync(path.join(DST, 'en', 'common.json'), JSON.stringify({ ...JSON.parse(rd(path.join(DST, 'en', 'common.json'))), devadded2: 'Second string' }, null, 2) + '\r\n');
		await vscode.commands.executeCommand('i18nSync.syncDestination');
		if (!(await until(() => es('common.json')?.devadded2 === AI('Second string'), 90000))) {throw new Error('not translated');}
		if (!(await until(() => JSON.parse(rd(path.join(SRC, 'common.json'))).devadded2 === 'Second string', 30000))) {throw new Error('fallback not written');}
		await set({ destinations: [{ path: DST, mode: 'translate', enabled: true }] });
	});

	await check('Sync Locales: a locale file with broken JSON is left untouched, the rest is synced, and the status page opens', async () => {
		const bad = path.join(DST, 'es', 'other.json');
		fs.writeFileSync(bad, '{ "o": ');
		fs.writeFileSync(path.join(DST, 'en', 'other.json'), JSON.stringify({ o: 'Other', more: 'More text' }, null, 2) + '\r\n');
		fs.writeFileSync(path.join(DST, 'en', 'common.json'), JSON.stringify({ ...JSON.parse(rd(path.join(DST, 'en', 'common.json'))), devadded3: 'Third string' }, null, 2) + '\r\n');
		await vscode.commands.executeCommand('i18nSync.syncDestination');
		if (!(await until(() => es('common.json')?.devadded3 === AI('Third string'), 90000))) {throw new Error('the healthy file was not synced');}
		if (rd(bad) !== '{ "o": ') {throw new Error('the broken file was modified: ' + rd(bad));}
		await vscode.commands.executeCommand('i18nSync.showStatus');
		await sleep(1500);
		fs.writeFileSync(bad, JSON.stringify({ o: 'Otro' }, null, 2) + '\n');
	});

	log('\n' + results.join('\n'));
	aiServer.close();
	gServer.close();
	if (results.some((r) => r.startsWith('FAIL'))) {throw new Error('some checks failed');}
};
