/** Test task definitions and the loader that validates untrusted task files. */

import { readFile } from "node:fs/promises";

/** `repair` fixes a failing suite; `write-tests` adds tests to a suite that already passes. */
export type TaskKind = "repair" | "write-tests";

/** Which tool produced the coverage report, and therefore how to read it. */
export type CoverageFormat = "python-json" | "istanbul-summary";

/** One source edit that the agent's tests must detect for the task to count as solved. */
export interface Mutation {
	/** File relative to the repository root. */
	readonly file: string;
	readonly find: string;
	readonly replace: string;
}

/** One test task: a repository, the commands that stage it, and the rules that judge it. */
export interface TestTask {
	readonly id: string;
	/** Repository path relative to the Ti package root, or an absolute path. */
	readonly repo: string;
	readonly kind: TaskKind;
	/** Commands run in order before the baseline test run. */
	readonly setup: readonly string[];
	/** Command that judges the task. `{junit}` and `{repoRoot}` are replaced. */
	readonly testCommand: string;
	/** What the agent is asked to do. */
	readonly prompt: string;
	/** Tools the agent may use. Anything not listed is unavailable. */
	readonly allowedTools: readonly string[];
	readonly timeoutMs: number;
	/** `write-tests` only: minimum total coverage percentage the final run must reach. */
	readonly coverageTarget?: number;
	/** `write-tests` only: coverage report path, relative to the repository root. */
	readonly coverageFile?: string;
	/** `write-tests` only: which coverage tool wrote `coverageFile`. Defaults to `python-json`. */
	readonly coverageFormat: CoverageFormat;
	/** `write-tests` only: edits that must turn the suite red if the new tests are meaningful. */
	readonly mutants: readonly Mutation[];
}

/** Read and validate a task file. Task files are untrusted input, so every field is checked. */
export async function loadTask(path: string): Promise<TestTask> {
	const raw: unknown = JSON.parse(await readFile(path, "utf-8"));
	return parseTask(raw, path);
}

function parseTask(raw: unknown, source: string): TestTask {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new Error(`${source}: task must be a JSON object`);
	}
	const value = raw as Record<string, unknown>;
	const kind = parseKind(value.kind, source);
	const task: TestTask = {
		id: requireString(value.id, "id", source),
		repo: requireString(value.repo, "repo", source),
		kind,
		setup: requireStringArray(value.setup, "setup", source),
		testCommand: requireString(value.testCommand, "testCommand", source),
		prompt: requireString(value.prompt, "prompt", source),
		allowedTools: requireStringArray(value.allowedTools, "allowedTools", source),
		timeoutMs: requirePositiveInteger(value.timeoutMs, "timeoutMs", source),
		coverageTarget: optionalNumber(value.coverageTarget, "coverageTarget", source),
		coverageFile: optionalString(value.coverageFile, "coverageFile", source),
		coverageFormat: parseCoverageFormat(value.coverageFormat, source),
		mutants: parseMutants(value.mutants, source),
	};
	if (kind === "write-tests") {
		if (task.coverageTarget === undefined) throw new Error(`${source}: "coverageTarget" is required for write-tests`);
		if (task.coverageFile === undefined) throw new Error(`${source}: "coverageFile" is required for write-tests`);
		if (task.mutants.length === 0) throw new Error(`${source}: "mutants" must not be empty for write-tests`);
	}
	return task;
}

function parseKind(value: unknown, source: string): TaskKind {
	if (value === undefined) return "repair";
	if (value === "repair" || value === "write-tests") return value;
	throw new Error(`${source}: "kind" must be "repair" or "write-tests"`);
}

function parseCoverageFormat(value: unknown, source: string): CoverageFormat {
	if (value === undefined) return "python-json";
	if (value === "python-json" || value === "istanbul-summary") return value;
	throw new Error(`${source}: "coverageFormat" must be "python-json" or "istanbul-summary"`);
}

function parseMutants(value: unknown, source: string): readonly Mutation[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error(`${source}: "mutants" must be an array`);
	return value.map((entry, index) => {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			throw new Error(`${source}: "mutants[${index}]" must be an object`);
		}
		const mutant = entry as Record<string, unknown>;
		return {
			file: requireString(mutant.file, `mutants[${index}].file`, source),
			find: requireString(mutant.find, `mutants[${index}].find`, source),
			replace: requireString(mutant.replace, `mutants[${index}].replace`, source),
		};
	});
}

function requireString(value: unknown, field: string, source: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${source}: "${field}" must be a non-empty string`);
	}
	return value;
}

function optionalString(value: unknown, field: string, source: string): string | undefined {
	if (value === undefined) return undefined;
	return requireString(value, field, source);
}

function optionalNumber(value: unknown, field: string, source: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${source}: "${field}" must be a number`);
	}
	return value;
}

function requireStringArray(value: unknown, field: string, source: string): readonly string[] {
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
		throw new Error(`${source}: "${field}" must be an array of non-empty strings`);
	}
	return value as readonly string[];
}

function requirePositiveInteger(value: unknown, field: string, source: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw new Error(`${source}: "${field}" must be a positive integer`);
	}
	return value;
}
