/** Command line entry: run tasks, or discover new ones from a coverage scan. */

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { discover, loadDiscoverConfig } from "./discover.ts";
import { renderReport } from "./report.ts";
import { describe, type RunResult, runTask } from "./runner.ts";
import { loadTask } from "./task.ts";

const DEFAULT_MODEL = "deepseek/deepseek-flash";
const packageRoot = join(import.meta.dirname, "..");
const repoRoot = join(packageRoot, "..", "..");

const USAGE = `usage:
  node src/cli.ts run <task.json...> [--model <provider/model>] [--runs-dir <dir>]
  node src/cli.ts discover <config.json>
`;

async function main(argv: readonly string[]): Promise<number> {
	const [command, ...rest] = argv;
	if (command === "run") return runTasks(rest);
	if (command === "discover") return discoverTasks(rest);
	process.stderr.write(USAGE);
	return 2;
}

async function runTasks(args: readonly string[]): Promise<number> {
	const options = parseRunOptions(args);
	await mkdir(options.runsDir, { recursive: true });

	const results: RunResult[] = [];
	for (const taskPath of options.taskPaths) {
		const task = await loadTask(resolve(taskPath));
		process.stdout.write(`\ntask ${task.id}: ${task.repo}\n`);
		const result = await runTask(task, {
			runsDir: options.runsDir,
			packageRoot,
			repoRoot,
			model: options.model,
			credentialsFile: join(homedir(), ".pi", "agent", "auth.json"),
			log,
		});
		results.push(result);
		printSummary(result);
	}

	const reportPath = join(options.runsDir, "report.html");
	await writeFile(reportPath, renderReport(results, new Date().toISOString()));
	const passed = results.filter((result) => result.passed).length;
	process.stdout.write(`\n${passed}/${results.length} passed\nreport ${reportPath}\n`);
	return passed === results.length ? 0 : 1;
}

async function discoverTasks(args: readonly string[]): Promise<number> {
	const configPath = args[0];
	if (configPath === undefined) {
		process.stderr.write(USAGE);
		return 2;
	}
	const config = await loadDiscoverConfig(resolve(configPath));
	const outputDir = resolve(packageRoot, config.outputDir);
	process.stdout.write(`discovering in ${config.repo} (threshold ${config.threshold}%, output ${outputDir})\n`);
	const tasks = await discover({ ...config, outputDir }, packageRoot, repoRoot, log);
	process.stdout.write(`\n${tasks.length} task(s) written\n`);
	for (const task of tasks) {
		process.stdout.write(
			`  ${task.id}  ${task.module}  ${task.coverage.toFixed(1)}%  ${task.mutants.length} mutants\n`,
		);
	}
	return 0;
}

interface RunOptions {
	readonly taskPaths: readonly string[];
	readonly model: string;
	readonly runsDir: string;
}

function parseRunOptions(args: readonly string[]): RunOptions {
	const taskPaths: string[] = [];
	let model = DEFAULT_MODEL;
	let runsDir = join(packageRoot, ".ti", "runs");
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--model") {
			model = args[index + 1] ?? model;
			index += 1;
			continue;
		}
		if (arg === "--runs-dir") {
			runsDir = resolve(args[index + 1] ?? runsDir);
			index += 1;
			continue;
		}
		if (arg !== undefined && !arg.startsWith("--")) taskPaths.push(arg);
	}
	if (taskPaths.length === 0) {
		throw new Error("missing task file; usage: node src/cli.ts run <task.json...>");
	}
	return { taskPaths, model, runsDir };
}

function printSummary(result: RunResult): void {
	process.stdout.write(`  kind      ${result.kind}\n`);
	process.stdout.write(`  baseline  ${describe(result.baseline)}${coverageSuffix(result.coverageBefore)}\n`);
	process.stdout.write(`  final     ${describe(result.final)}${coverageSuffix(result.coverageAfter)}\n`);
	if (result.mutations.length > 0) {
		const killed = result.mutations.filter((mutation) => mutation.killed).length;
		process.stdout.write(`  mutants   ${killed}/${result.mutations.length} killed\n`);
	}
	process.stdout.write(`  verdict   ${result.passed ? "PASSED" : "FAILED"}\n`);
	process.stdout.write(`  duration  ${Math.round(result.durationMs / 1000)}s\n`);
	process.stdout.write(`  artifacts ${result.runDir}\n`);
}

function coverageSuffix(value: number | null): string {
	return value === null ? "" : `, coverage ${value.toFixed(1)}%`;
}

function log(message: string): void {
	process.stdout.write(`  ${message}\n`);
}

try {
	process.exitCode = await main(process.argv.slice(2));
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
