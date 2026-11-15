/** Placeholder expansion for task command templates. */

/** Replace `{junit}` and `{repoRoot}` in a task command. */
export function expandCommand(command: string, junitPath: string, repoRoot: string): string {
	return command.replaceAll("{junit}", junitPath).replaceAll("{repoRoot}", repoRoot);
}
