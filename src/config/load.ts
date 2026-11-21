// RED stub (plan 01-06 task 1): replaced by the real loader in the GREEN commit.
export type ConfigIssue = {
	code: string;
	at?: string;
	line?: number;
	col?: number;
};

export class ConfigError extends Error {
	readonly issues: readonly ConfigIssue[];

	constructor(issues: readonly ConfigIssue[]) {
		super(`invalid configuration: ${issues.length} issue(s)`);
		this.issues = issues;
	}
}

export function loadConfig(_env: NodeJS.ProcessEnv = process.env): unknown {
	return {};
}
