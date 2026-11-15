/** Run one task end to end: stage the repo, hand it to pi, then judge with tests, coverage and mutants. */

import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expandCommand } from "./command.ts";
import { runCommandLine, runExecutable } from "./exec.ts";
import { isGreen, parseCoverageJson, parseIstanbulSummary, parseJUnitXml, type TestSummary } from "./judge.ts";
import type { Mutation, TestTask } from "./task.ts";

/** Where a run writes: the artifact directory, the pi install to call, and the model to use. */
export interface RunOptions {
	readonly runsDir: string;
	/** Base directory that `task.repo` is resolved against. */
	readonly packageRoot: string;
	readonly repoRoot: string;
	readonly model: string;
	/** The pi credentials file copied into each run, so the agent never sees the real agent dir. */
	readonly credentialsFile: string;
	readonly log: (message: string) => void;
}

/** Whether one mutation was detected by the agent's tests. */
export interface MutationResult {
	readonly file: string;
	/** True when the edit made the suite fail, which is what a meaningful test must do. */
	readonly killed: boolean;
	readonly detail: string;
}

/** Everything one run produced, written to `result.json` next to the artifacts. */
export interface RunResult {
	readonly taskId: string;
	readonly kind: TestTask["kind"];
	readonly runDir: string;
	readonly baseline: TestSummary;
	readonly final: TestSummary;
	readonly coverageBefore: number | null;
	readonly coverageAfter: number | null;
	readonly coverageTarget: number | null;
	readonly mutations: readonly MutationResult[];
	readonly passed: boolean;
	readonly agentExitCode: number;
	readonly durationMs: number;
	readonly diff: string;
}

/** Run one task. Throws when staging or setup fails, since those are infrastructure failures. */
export async function runTask(task: TestTask, options: RunOptions): Promise<RunResult> {
	const startedAt = Date.now();
	const runDir = join(options.runsDir, `${startedAt}-${task.id}`);
	const repoDir = join(runDir, "repo");
	const agentDir = join(runDir, "agent");
	await mkdir(agentDir, { recursive: true });
	await mkdir(repoDir, { recursive: true });

	options.log(`staging ${task.repo} -> ${repoDir}`);
	await cp(resolve(options.packageRoot, task.repo), repoDir, { recursive: true });
	await copyFile(options.credentialsFile, join(agentDir, "auth.json"));
	await ensureGitBaseline(repoDir);

	for (const command of task.setup) {
		options.log(`setup: ${command}`);
		const setup = await runCommandLine(command, repoDir, task.timeoutMs);
		await writeFile(join(runDir, "setup.log"), setup.output);
		if (setup.exitCode !== 0) {
			throw new Error(`setup failed with exit code ${setup.exitCode}: ${command}`);
		}
	}

	const baseline = await judgeTests(task, repoDir, runDir, "baseline", options);
	const coverageBefore = await readCoverage(task, repoDir);
	options.log(`baseline: ${describe(baseline)}${coverageText(coverageBefore)}`);

	const agent = await runAgent(task, repoDir, agentDir, options, runDir);
	options.log(`agent exited with ${agent.exitCode}`);

	const final = await judgeTests(task, repoDir, runDir, "final", options);
	const coverageAfter = await readCoverage(task, repoDir);
	options.log(`final: ${describe(final)}${coverageText(coverageAfter)}`);

	const mutations = task.kind === "write-tests" ? await checkMutants(task, repoDir, runDir, options) : [];
	const diff = await gitDiff(repoDir);
	const result: RunResult = {
		taskId: task.id,
		kind: task.kind,
		runDir,
		baseline,
		final,
		coverageBefore,
		coverageAfter,
		coverageTarget: task.coverageTarget ?? null,
		mutations,
		passed: decide(task, baseline, final, coverageAfter, mutations),
		agentExitCode: agent.exitCode,
		durationMs: Date.now() - startedAt,
		diff,
	};
	await writeFile(join(runDir, "result.json"), JSON.stringify(result, null, 2));
	return result;
}

/** One-line summary of a test run, for log output and the console report. */
export function describe(summary: TestSummary): string {
	const parts = [`${summary.passed}/${summary.total} passed`];
	if (summary.failed > 0) parts.push(`${summary.failed} failed`);
	if (summary.errors > 0) parts.push(`${summary.errors} errors`);
	if (summary.skipped > 0) parts.push(`${summary.skipped} skipped`);
	return parts.join(", ");
}

/**
 * Decide the outcome. `repair` needs a red baseline turned green; `write-tests` needs a green
 * suite, the coverage target reached, and every mutant detected.
 */
function decide(
	task: TestTask,
	baseline: TestSummary,
	final: TestSummary,
	coverageAfter: number | null,
	mutations: readonly MutationResult[],
): boolean {
	if (task.kind === "repair") return !isGreen(baseline) && isGreen(final);
	if (!isGreen(final)) return false;
	if (task.coverageTarget !== undefined && (coverageAfter ?? 0) < task.coverageTarget) return false;
	return mutations.every((mutation) => mutation.killed);
}

async function judgeTests(
	task: TestTask,
	repoDir: string,
	runDir: string,
	label: string,
	options: RunOptions,
): Promise<TestSummary> {
	const reportPath = join(runDir, `${label}.xml`);
	const command = expandCommand(task.testCommand, reportPath, options.repoRoot);
	options.log(`test (${label}): ${command}`);
	const run = await runCommandLine(command, repoDir, task.timeoutMs);
	await writeFile(join(runDir, `${label}.log`), run.output);
	return parseJUnitXml(await readFile(reportPath, "utf-8"));
}

async function readCoverage(task: TestTask, repoDir: string): Promise<number | null> {
	if (task.coverageFile === undefined) return null;
	const path = join(repoDir, task.coverageFile);
	if (!existsSync(path)) return null;
	const text = await readFile(path, "utf-8");
	return task.coverageFormat === "istanbul-summary" ? parseIstanbulSummary(text) : parseCoverageJson(text);
}

function coverageText(value: number | null): string {
	return value === null ? "" : `, coverage ${value.toFixed(1)}%`;
}

async function checkMutants(
	task: TestTask,
	repoDir: string,
	runDir: string,
	options: RunOptions,
): Promise<readonly MutationResult[]> {
	const results: MutationResult[] = [];
	for (const [index, mutant] of task.mutants.entries()) {
		results.push(await checkMutant(task, repoDir, runDir, mutant, index, options));
	}
	return results;
}

async function checkMutant(
	task: TestTask,
	repoDir: string,
	runDir: string,
	mutant: Mutation,
	index: number,
	options: RunOptions,
): Promise<MutationResult> {
	const path = join(repoDir, mutant.file);
	const original = await readFile(path, "utf-8");
	if (!original.includes(mutant.find)) {
		return { file: mutant.file, killed: false, detail: "pattern not found in source" };
	}
	await writeFile(path, original.replace(mutant.find, mutant.replace));
	try {
		const command = expandCommand(task.testCommand, join(runDir, `mutant-${index}.xml`), options.repoRoot);
		const run = await runCommandLine(command, repoDir, task.timeoutMs);
		await writeFile(join(runDir, `mutant-${index}.log`), run.output);
		return { file: mutant.file, killed: run.exitCode !== 0, detail: `exit ${run.exitCode}` };
	} finally {
		await writeFile(path, original);
	}
}

async function runAgent(
	task: TestTask,
	repoDir: string,
	agentDir: string,
	options: RunOptions,
	runDir: string,
): Promise<{ exitCode: number }> {
	const cliPath = join(options.repoRoot, "packages", "coding-agent", "src", "cli.ts");
	const resolverPath = join(options.repoRoot, "packages", "coding-agent", "src", "experimental", "source-resolver.ts");
	const args = [
		"--import",
		pathToFileURL(resolverPath).href,
		cliPath,
		"-p",
		"--offline",
		"--no-session",
		"--no-extensions",
		"--no-mcp",
		"--no-context-files",
		"--no-skills",
		"--no-prompt-templates",
		"--model",
		options.model,
		"--tools",
		task.allowedTools.join(","),
		task.prompt,
	];
	options.log(`agent: ${options.model}, tools ${task.allowedTools.join(",")}`);
	const run = await runExecutable(process.execPath, args, repoDir, task.timeoutMs, {
		...process.env,
		PI_CODING_AGENT_DIR: agentDir,
	});
	await writeFile(join(runDir, "agent.log"), run.output);
	return { exitCode: run.exitCode };
}

async function ensureGitBaseline(repoDir: string): Promise<void> {
	await runCommandLine("git init -q", repoDir, 60_000);
	await runCommandLine("git config core.autocrlf false", repoDir, 60_000);
	await runCommandLine("git add -A", repoDir, 120_000);
	await runCommandLine(
		"git -c user.name=ti -c user.email=ti@local commit -qm baseline",
		repoDir,
		120_000,
	);
}

async function gitDiff(repoDir: string): Promise<string> {
	await runCommandLine("git add -A -N", repoDir, 120_000);
	const diff = await runCommandLine("git diff", repoDir, 120_000);
	// Git's CRLF advisories go to the same pipe as the patch; drop them so the diff stays applyable.
	return diff.output
		.split("\n")
		.filter((line) => !line.startsWith("warning:"))
		.join("\n")
		.trimEnd();
}
