import * as assert from 'node:assert';

export { assert };

const results: { name: string; error?: Error }[] = [];

/** Run one named scenario; failures are collected and reported by done(). */
export async function scenario(name: string, fn: () => Promise<void> | void): Promise<void> {
	try {
		await fn();
		results.push({ name });
	} catch (e) {
		results.push({ name, error: e as Error });
	}
}

/** Print the results and set the exit code. */
export function done(): void {
	for (const r of results) {
		console.log(r.error ? `FAIL  ${r.name}\n      ${r.error.message.split('\n').slice(0, 6).join('\n      ')}` : `PASS  ${r.name}`);
	}
	const bad = results.filter((r) => r.error).length;
	console.log(`${results.length - bad}/${results.length} passed`);
	process.exit(bad ? 1 : 0);
}
