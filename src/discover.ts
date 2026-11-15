/** Discover write-tests tasks: find under-covered modules and mutants the current suite misses. */

import { existsSync } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { expandCommand } from "./command.ts";
import { runCommandLine } from "./exec.ts";
import { parseIstanbulPerFile, parseUncoveredRanges, type UncoveredRange } from "./judge.ts";
import { type Candidate, countOccurrences, findCandidates } from "./mutate.ts";
import type { CoverageFormat, Mutation } from "./task.ts";

/** How one discovery pass scans a repository. */
export interface DiscoverConfig {
	/** Repository path relative to the Ti package root, or absolute. */
	readonly repo: string;
	/** Command used while scanning: must produce `coverageFile` and a JUnit report at `{junit}`. */
	readonly discoverCommand: string;
	/** Command written into generated tasks. `{module}` is replaced with the module path. */
	readonly taskCommand: string;
	readonly coverageFile: string;
	/** Optional istanbul `coverage-final.json`; when present, mutations are limited to unexecuted lines. */
	readonly coverageDetailFile?: string;
	readonly coverageFormat: CoverageFormat;
	/** Modules below this line-coverage percentage become tasks. */
	readonly threshold: number;
	readonly mutantsPerTask: number;
	readonly maxCandidatesPerFile: number;
	/** Skip modules with fewer coverable lines than this. */
	readonly minLines: number;
	readonly outputDir: string;
	readonly timeoutMs: number;
	readonly allowedTools: readonly string[];
}

/** One generated task, as written to `outputDir`. */
export interface DiscoveredTask {
	readonly id: string;
	readonly module: string;
	readonly coverage: number;
	readonly mutants: readonly Mutation[];
	readonly path: string;
}

/**
 * Scan a repository and write one `write-tests` task per under-covered module.
 * A module is only turned into a task when at least one mutation survives the current suite:
 * an already-killed mutation would let the agent pass without writing any new test.
 */
export async function discover(
	config: DiscoverConfig,
	packageRoot: string,
	repoRoot: string,
	log: (message: string) => void,
): Promise<readonly DiscoveredTask[]> {
	const workDir = join(packageRoot, ".ti", "discover", String(Date.now()));
	const repoDir = join(workDir, "repo");
	await mkdir(workDir, { recursive: true });
	await mkdir(repoDir, { recursive: true });
	await cp(resolve(packageRoot, config.repo), repoDir, { recursive: true });

	log("running the suite for a coverage baseline");
	const baseline = await runCommandLine(
		expandCommand(config.discoverCommand, join(workDir, "baseline.xml"), repoRoot),
		repoDir,
		config.timeoutMs,
	);
	await writeFile(join(workDir, "baseline.log"), baseline.output);
	if (baseline.exitCode !== 0) {
		throw new Error(`baseline suite failed with exit code ${baseline.exitCode}; cannot discover`);
	}

	const summary = parseIstanbulPerFile(await readFile(join(repoDir, config.coverageFile), "utf-8"));
	const candidates = summary
		.map((entry) => ({ ...entry, module: toModulePath(entry.file, repoDir) }))
		.filter((entry) => entry.module !== undefined)
		.filter((entry) => entry.percent < config.threshold && entry.total >= config.minLines)
		.sort((left, right) => left.percent - right.percent);
	log(`${candidates.length} module(s) below ${config.threshold}% with at least ${config.minLines} lines`);

	const tasks: DiscoveredTask[] = [];
	for (const entry of candidates) {
		const module = entry.module;
		if (module === undefined) continue;
		const mutants = await findSurvivingMutants(
			config,
			repoDir,
			workDir,
			module,
			await readUncovered(config, repoDir, module),
			repoRoot,
			log,
		);
		if (mutants.length === 0) {
			log(`${module}: every candidate mutation was already caught; skipping`);
			continue;
		}
		const task = renderTask(config, module, entry.percent, mutants);
		const path = join(config.outputDir, `${task.id}.json`);
		await mkdir(config.outputDir, { recursive: true });
		await writeFile(path, `${JSON.stringify(task, null, "\t")}\n`);
		tasks.push({ id: task.id, module, coverage: entry.percent, mutants, path });
		log(`${module}: ${entry.percent.toFixed(1)}% -> ${task.id} (${mutants.length} survivors)`);
	}
	return tasks;
}

interface GeneratedTask {
	readonly id: string;
	readonly repo: string;
	readonly kind: "write-tests";
	readonly setup: readonly string[];
	readonly testCommand: string;
	readonly prompt: string;
	readonly allowedTools: readonly string[];
	readonly timeoutMs: number;
	readonly coverageTarget: number;
	readonly coverageFile: string;
	readonly coverageFormat: CoverageFormat;
	readonly mutants: readonly Mutation[];
}

async function readUncovered(
	config: DiscoverConfig,
	repoDir: string,
	module: string,
): Promise<readonly UncoveredRange[]> {
	if (config.coverageDetailFile === undefined) return [];
	const path = join(repoDir, config.coverageDetailFile);
	if (!existsSync(path)) return [];
	return parseUncoveredRanges(await readFile(path, "utf-8"), module);
}

/** True when the rewrite sits inside a statement that never ran. */
function sitsInUncovered(ranges: readonly UncoveredRange[], candidate: Candidate): boolean {
	return ranges.some((range) => {
		const afterStart =
			candidate.line > range.startLine ||
			(candidate.line === range.startLine && candidate.column >= range.startColumn);
		const beforeEnd =
			candidate.line < range.endLine || (candidate.line === range.endLine && candidate.column <= range.endColumn);
		return afterStart && beforeEnd;
	});
}

async function findSurvivingMutants(
	config: DiscoverConfig,
	repoDir: string,
	workDir: string,
	module: string,
	uncovered: readonly UncoveredRange[],
	repoRoot: string,
	log: (message: string) => void,
): Promise<readonly Mutation[]> {
	const path = join(repoDir, module);
	const source = await readFile(path, "utf-8");
	const survivors: Mutation[] = [];
	for (const candidate of findCandidates(source, config.maxCandidatesPerFile)) {
		if (survivors.length >= config.mutantsPerTask) break;
		if (uncovered.length > 0 && !sitsInUncovered(uncovered, candidate)) continue;
		if (countOccurrences(source, candidate.find) !== 1) continue;
		await writeFile(path, source.replace(candidate.find, candidate.replace));
		try {
			const run = await runCommandLine(
				expandCommand(config.discoverCommand, join(workDir, "mutant.xml"), repoRoot),
				repoDir,
				config.timeoutMs,
			);
			if (run.exitCode === 0) {
				survivors.push({ file: module, find: candidate.find, replace: candidate.replace });
			}
		} finally {
			await writeFile(path, source);
		}
	}
	log(`${module}: ${survivors.length} surviving mutant(s)`);
	return survivors;
}

function renderTask(
	config: DiscoverConfig,
	module: string,
	coverage: number,
	mutants: readonly Mutation[],
): GeneratedTask {
	const id = `${slug(basename(config.repo))}-${slug(module.replace(/^src[\\/]/, "").replace(/\.[^.]+$/, ""))}-tests`;
	const testFile = `test/${basename(module).replace(/\.[^.]+$/, "")}.test.ts`;
	return {
		id,
		repo: config.repo,
		kind: "write-tests",
		setup: [],
		testCommand: config.taskCommand.replaceAll("{module}", module),
		prompt: `${module} has no dedicated tests: line coverage is ${coverage.toFixed(1)}%. Write tests for it in ${testFile}. Requirements: every test passes; line coverage of ${module} reaches at least ${config.threshold}%; the tests must be meaningful and would fail against a wrong implementation, not merely call each exported function once. Do not modify ${module}.`,
		allowedTools: config.allowedTools,
		timeoutMs: config.timeoutMs,
		coverageTarget: config.threshold,
		coverageFile: config.coverageFile,
		coverageFormat: config.coverageFormat,
		mutants,
	};
}

/** Keep only top-level `src/<name>.ts` modules: nested directories are usually vendored code. */
function toModulePath(file: string, repoDir: string): string | undefined {
	const relativePath = relative(repoDir, resolve(file));
	if (relativePath.startsWith("..")) return undefined;
	const parts = relativePath.split(sep);
	if (parts.length !== 2 || parts[0] !== "src") return undefined;
	return parts.join("/");
}

function slug(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** Read and validate a discovery config. Config files are untrusted input, so every field is checked. */
export async function loadDiscoverConfig(path: string): Promise<DiscoverConfig> {
	const raw: unknown = JSON.parse(await readFile(path, "utf-8"));
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new Error(`${path}: discovery config must be a JSON object`);
	}
	const value = raw as Record<string, unknown>;
	const format = value.coverageFormat;
	return {
		repo: text(value.repo, "repo", path),
		discoverCommand: text(value.discoverCommand, "discoverCommand", path),
		taskCommand: text(value.taskCommand, "taskCommand", path),
		coverageFile: text(value.coverageFile, "coverageFile", path),
		coverageDetailFile: optionalText(value.coverageDetailFile, "coverageDetailFile", path),
		coverageFormat: format === "python-json" || format === "istanbul-summary" ? format : "istanbul-summary",
		threshold: number(value.threshold, "threshold", path),
		mutantsPerTask: count(value.mutantsPerTask, "mutantsPerTask", path),
		maxCandidatesPerFile: count(value.maxCandidatesPerFile, "maxCandidatesPerFile", path),
		minLines: count(value.minLines, "minLines", path),
		outputDir: text(value.outputDir, "outputDir", path),
		timeoutMs: count(value.timeoutMs, "timeoutMs", path),
		allowedTools: texts(value.allowedTools, "allowedTools", path),
	};
}

function text(value: unknown, field: string, source: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${source}: "${field}" must be a non-empty string`);
	}
	return value;
}

function optionalText(value: unknown, field: string, source: string): string | undefined {
	if (value === undefined) return undefined;
	return text(value, field, source);
}

function number(value: unknown, field: string, source: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${source}: "${field}" must be a number`);
	}
	return value;
}

function count(value: unknown, field: string, source: string): number {
	const parsed = number(value, field, source);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(`${source}: "${field}" must be a positive integer`);
	}
	return parsed;
}

function texts(value: unknown, field: string, source: string): readonly string[] {
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
		throw new Error(`${source}: "${field}" must be an array of non-empty strings`);
	}
	return value as readonly string[];
}
