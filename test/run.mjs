// Bundles every test/*.test.ts with esbuild and runs them one after another with plain node.
// Usage: node test/run.mjs [name-filter]
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', '.test-out');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const filter = process.argv[2];
const files = readdirSync(here).filter((f) => f.endsWith('.test.ts') && (!filter || f.includes(filter)));
let failed = 0;
for (const f of files) {
	const outfile = join(out, f.replace(/\.ts$/, '.js'));
	await build({
		entryPoints: [join(here, f)],
		bundle: true,
		platform: 'node',
		mainFields: ['module', 'main'],
		external: ['vscode'],
		outfile,
		logLevel: 'error',
	});
	console.log(`\n=== ${f}`);
	const r = spawnSync(process.execPath, [outfile], { stdio: 'inherit' });
	if (r.status !== 0) {
		failed++;
	}
}
console.log(failed ? `\n${failed} test file(s) FAILED` : `\nall ${files.length} test file(s) passed`);
process.exit(failed ? 1 : 0);
