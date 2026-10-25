import * as os from 'os';
import * as path from 'path';

/**
 * A folder typed by the user: `~` means the home folder (macOS/Linux habit), and an empty value stays empty
 * (path.normalize('') would turn it into '.', which would look like a real folder).
 */
export function resolveUserPath(p: string): string {
	const t = p.trim();
	if (!t) {
		return '';
	}
	const home = t === '~' || t.startsWith('~/') || t.startsWith('~\\');
	return path.normalize(home ? path.join(os.homedir(), t.slice(1)) : t);
}
