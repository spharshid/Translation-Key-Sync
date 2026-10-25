// Runs test/vscode/suite.cjs inside a real VS Code (downloaded once into .vscode-test/) against the compiled extension.
// Usage: npm run compile && npm run test:vscode
delete process.env.ELECTRON_RUN_AS_NODE; // set when this is started from inside VS Code; would make Electron behave like plain node
delete process.env.VSCODE_IPC_HOOK_CLI;
delete process.env.VSCODE_PID;

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');
const { runTests } = require('@vscode/test-electron');

(async () => {
	const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tks-it-')));
	const SRC_REPO = path.join(tmp, 'SourceRepo');
	const DST_REPO = path.join(tmp, 'DestinationRepo');
	const sh = (c, cwd) => execSync(c, { cwd, stdio: 'pipe' }).toString().trim();
	const json = (o) => JSON.stringify(o, null, 2).replace(/\n/g, '\r\n') + '\r\n';

	for (const repo of [SRC_REPO, DST_REPO]) {
		fs.mkdirSync(repo, { recursive: true });
		sh('git init -q && git config user.email me@me.com && git config user.name Me && git config core.autocrlf false', repo);
	}
	const base = { save: 'Save', gone: 'Remove me', nested: { a: 'A', b: 'B' } };
	const SRC = path.join(SRC_REPO, 'locales', 'en');
	fs.mkdirSync(SRC, { recursive: true });
	fs.writeFileSync(path.join(SRC, 'common.json'), json(base));
	fs.writeFileSync(path.join(SRC, 'other.json'), json({ o: 'Other' }));
	sh('git add -A && git commit -q -m init', SRC_REPO);

	const DST = path.join(DST_REPO, 'locales');
	const spanish = { save: 'Guardar', gone: 'Quitar', nested: { a: 'A', b: 'B' } };
	for (const l of ['en', 'es']) {
		fs.mkdirSync(path.join(DST, l), { recursive: true });
		fs.writeFileSync(path.join(DST, l, 'common.json'), json(l === 'es' ? spanish : base));
		fs.writeFileSync(path.join(DST, l, 'other.json'), json({ o: l === 'es' ? 'Otro' : 'Other' }));
	}
	sh('git add -A && git commit -q -m init', DST_REPO);

	const OUT = path.join(tmp, 'result.txt');
	console.log('workspace:', tmp);
	try {
		await runTests({
			version: 'stable',
			cachePath: path.join(__dirname, '..', '..', '.vscode-test'),
			extensionDevelopmentPath: path.join(__dirname, '..', '..'),
			extensionTestsPath: process.env.TKS_SUITE || path.join(__dirname, 'suite.cjs'),
			launchArgs: [SRC_REPO, '--disable-extensions', '--user-data-dir', path.join(tmp, 'ud'), '--extensions-dir', path.join(tmp, 'ex')],
			extensionTestsEnv: { TKS_SRC_REPO: SRC_REPO, TKS_DST_REPO: DST_REPO, TKS_OUT: OUT },
		});
	} catch (e) {
		console.log('runner error:', e.message);
		process.exitCode = 1;
	}
	console.log(fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : 'no result file');
})();
