/**
 * An optional endpoint profile that a local build may provide. This is the stub every other build uses: it provides none.
 */
export interface ProfileConfig {
	key: string;
	/** OpenAI-compatible base URL */
	endpoint: string;
	/** one or more models behind the key */
	models: string[];
}

/** Facts about the configured repos that a profile may look at. */
export interface ProfileContext {
	/** remote URLs of the configured repos */
	remotes: string[];
	/** the configured folders */
	folders: string[];
}

/** Is the profile meant for this setup? Asked when the settings are saved. */
export function profileUnlocked(_ctx: ProfileContext): boolean {
	return false;
}

export function profileConfig(): ProfileConfig | undefined {
	return undefined;
}
