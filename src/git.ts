import { execFile } from 'child_process';

export function git(gitPath: string, cwd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(gitPath, args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
			if (err) {
				reject(new Error(stderr?.toString().trim() || err.message));
			} else {
				resolve(stdout.toString());
			}
		});
	});
}

export interface CommitInfo {
	parents: string[];
	authorEmail: string;
}

export async function getCommitInfo(gitPath: string, cwd: string, hash: string): Promise<CommitInfo> {
	const out = (await git(gitPath, cwd, ['log', '-1', '--format=%P%n%ae', hash])).split('\n');
	return { parents: out[0].trim() ? out[0].trim().split(' ') : [], authorEmail: (out[1] ?? '').trim() };
}

export async function getUserEmail(gitPath: string, cwd: string): Promise<string> {
	try {
		return (await git(gitPath, cwd, ['config', 'user.email'])).trim();
	} catch {
		return '';
	}
}

/** Files (repo-relative, forward slashes) changed between two commits under a directory. */
export async function changedFiles(
	gitPath: string,
	cwd: string,
	from: string,
	to: string,
	relDir: string,
): Promise<{ status: string; file: string }[]> {
	const out = await git(gitPath, cwd, ['diff', '--name-status', '--no-renames', from, to, '--', relDir]);
	return out
		.split('\n')
		.filter(Boolean)
		.map((l) => {
			const [status, ...rest] = l.split('\t');
			return { status, file: rest.join('\t') };
		});
}

/** Raw text of a file at a ref (BOM stripped), or null if it does not exist there. */
export async function rawAt(gitPath: string, cwd: string, ref: string, relFile: string): Promise<string | null> {
	try {
		return (await git(gitPath, cwd, ['show', `${ref}:${relFile}`])).replace(/^﻿/, '');
	} catch {
		return null;
	}
}

/** Parsed JSON of a file at a ref, or null if it does not exist there / is not valid JSON. */
export async function jsonAt(gitPath: string, cwd: string, ref: string, relFile: string): Promise<{ doc: any; raw: string } | null> {
	const raw = await rawAt(gitPath, cwd, ref, relFile);
	if (raw === null) {
		return null;
	}
	try {
		return { doc: JSON.parse(raw), raw };
	} catch {
		return null;
	}
}
