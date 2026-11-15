/** Child process helpers shared by the runner and the discovery pass. */

import { spawn } from "node:child_process";

/** Exit code and combined stdout/stderr of one finished process. */
export interface ShellResult {
	readonly exitCode: number;
	readonly output: string;
}

/** Run a shell command line (used for task-defined setup and test commands). */
export function runCommandLine(command: string, cwd: string, timeoutMs: number): Promise<ShellResult> {
	return spawnAndCollect(command, [], { cwd, timeoutMs, shell: true, env: process.env });
}

/** Run an executable with argument boundaries preserved (used for the agent process). */
export function runExecutable(
	file: string,
	args: readonly string[],
	cwd: string,
	timeoutMs: number,
	env: NodeJS.ProcessEnv,
): Promise<ShellResult> {
	return spawnAndCollect(file, args, { cwd, timeoutMs, shell: false, env });
}

function spawnAndCollect(
	command: string,
	args: readonly string[],
	options: { cwd: string; timeoutMs: number; shell: boolean; env: NodeJS.ProcessEnv },
): Promise<ShellResult> {
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(command, [...args], {
			cwd: options.cwd,
			env: options.env,
			shell: options.shell,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, options.timeoutMs);
		child.stdout?.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			rejectPromise(error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (timedOut) {
				resolvePromise({ exitCode: 124, output: `${output}\n[timeout after ${options.timeoutMs}ms]` });
				return;
			}
			resolvePromise({ exitCode: code ?? 1, output });
		});
	});
}
