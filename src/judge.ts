/** JUnit XML parsing: the only thing that decides whether a task passed. */

/** One failing or erroring test case, reduced to what the report needs. */
export interface TestFailure {
	readonly test: string;
	readonly message: string;
}

/** Counts from one test run, plus the failing cases in reading order. */
export interface TestSummary {
	readonly total: number;
	readonly passed: number;
	readonly failed: number;
	readonly errors: number;
	readonly skipped: number;
	readonly failures: readonly TestFailure[];
}

const SUITE_PATTERN = /<testsuite\b([^>]*)>/g;
const CASE_PATTERN = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
const ATTRIBUTE_PATTERN = /([\w:-]+)="([^"]*)"/g;

/** Parse a JUnit XML report into counts and failures. Throws on input that is not JUnit XML. */
export function parseJUnitXml(xml: string): TestSummary {
	if (!/<testsuites?\b/.test(xml) && !/<testcase\b/.test(xml)) {
		throw new Error("report is not JUnit XML: no <testsuite> or <testcase> element");
	}

	// pytest and Maven put counts on <testsuite>; Node's reporter emits only a <testsuites>
	// wrapper with flat <testcase> children, so counts are derived from the cases when absent.
	let suiteTotal = 0;
	let suiteFailed = 0;
	let suiteErrors = 0;
	let suiteSkipped = 0;
	for (const match of xml.matchAll(SUITE_PATTERN)) {
		const attributes = parseAttributes(match[1] ?? "");
		suiteTotal += toCount(attributes.tests);
		suiteFailed += toCount(attributes.failures);
		suiteErrors += toCount(attributes.errors);
		suiteSkipped += toCount(attributes.skipped);
	}

	const failures: TestFailure[] = [];
	let cases = 0;
	let caseFailed = 0;
	let caseErrors = 0;
	let caseSkipped = 0;
	for (const match of xml.matchAll(CASE_PATTERN)) {
		cases += 1;
		const attributes = parseAttributes(match[1] ?? "");
		const body = match[2] ?? "";
		if (/<failure\b/.test(body)) {
			caseFailed += 1;
			failures.push({ test: caseName(attributes), message: failureMessage(body, "failure") });
			continue;
		}
		if (/<error\b/.test(body)) {
			caseErrors += 1;
			failures.push({ test: caseName(attributes), message: failureMessage(body, "error") });
			continue;
		}
		if (/<skipped\b/.test(body)) caseSkipped += 1;
	}

	const fromSuites = suiteTotal > 0;
	const total = fromSuites ? suiteTotal : cases;
	const failed = fromSuites ? suiteFailed : caseFailed;
	const errors = fromSuites ? suiteErrors : caseErrors;
	const skipped = fromSuites ? suiteSkipped : caseSkipped;
	return {
		total,
		passed: Math.max(0, total - failed - errors - skipped),
		failed,
		errors,
		skipped,
		failures,
	};
}

/** True when the run finished with no failures and no errors. */
export function isGreen(summary: TestSummary): boolean {
	return summary.failed === 0 && summary.errors === 0;
}

/**
 * Read total line coverage from an istanbul JSON summary (`--coverage.reporter=json-summary`).
 * Tasks narrow the report with `--coverage.include`, so `total` is the module under test.
 */
export function parseIstanbulSummary(text: string): number {
	const parsed: unknown = JSON.parse(text);
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error("coverage summary is not a JSON object");
	}
	const total = (parsed as Record<string, unknown>).total;
	if (typeof total !== "object" || total === null) {
		throw new Error("coverage summary has no total entry");
	}
	const lines = (total as Record<string, unknown>).lines;
	if (typeof lines !== "object" || lines === null) {
		throw new Error("coverage summary has no total.lines entry");
	}
	const percent = (lines as Record<string, unknown>).pct;
	if (typeof percent !== "number" || !Number.isFinite(percent)) {
		throw new Error("coverage summary has no numeric total.lines.pct");
	}
	return percent;
}

/** One file's line coverage from an istanbul JSON summary. */
export interface FileCoverage {
	/** Path as it appears in the report, usually absolute. */
	readonly file: string;
	readonly percent: number;
	readonly total: number;
	readonly covered: number;
}

/** A source span whose statement never ran, from an istanbul `coverage-final.json`. */
export interface UncoveredRange {
	readonly startLine: number;
	readonly startColumn: number;
	readonly endLine: number;
	readonly endColumn: number;
}

/**
 * Read the spans of statements that never executed.
 * Spans, not lines: a line can hold an executed condition and an unexecuted branch,
 * and only the branch is safe to mutate for a "write tests" task.
 */
export function parseUncoveredRanges(text: string, targetFile: string): readonly UncoveredRange[] {
	const parsed: unknown = JSON.parse(text);
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error("coverage detail is not a JSON object");
	}
	const target = normalizePath(targetFile);
	for (const [file, value] of Object.entries(parsed)) {
		if (!normalizePath(file).endsWith(target)) continue;
		if (typeof value !== "object" || value === null) continue;
		const entry = value as Record<string, unknown>;
		const statementMap = entry.statementMap;
		const counts = entry.s;
		if (typeof statementMap !== "object" || statementMap === null) continue;
		if (typeof counts !== "object" || counts === null) continue;
		const ranges: UncoveredRange[] = [];
		for (const [id, location] of Object.entries(statementMap)) {
			if ((counts as Record<string, unknown>)[id] !== 0) continue;
			const range = toRange(location);
			if (range !== undefined) ranges.push(range);
		}
		return ranges;
	}
	throw new Error(`coverage detail has no entry for ${targetFile}`);
}

function toRange(location: unknown): UncoveredRange | undefined {
	if (typeof location !== "object" || location === null) return undefined;
	const value = location as Record<string, unknown>;
	const start = position(value.start);
	const end = position(value.end);
	if (start === undefined || end === undefined) return undefined;
	// v8 coverage reports `end.column: null`; such a statement runs to the end of its last line.
	return {
		startLine: start.line,
		startColumn: start.column ?? 0,
		endLine: end.line,
		endColumn: end.column ?? Number.MAX_SAFE_INTEGER,
	};
}

function position(value: unknown): { line: number; column: number | null } | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const entry = value as Record<string, unknown>;
	if (typeof entry.line !== "number") return undefined;
	const column = typeof entry.column === "number" ? entry.column : null;
	return { line: entry.line, column };
}

function normalizePath(value: string): string {
	return value.replaceAll("\\", "/");
}

/** Read per-file line coverage from an istanbul JSON summary, skipping the `total` entry. */
export function parseIstanbulPerFile(text: string): readonly FileCoverage[] {
	const parsed: unknown = JSON.parse(text);
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error("coverage summary is not a JSON object");
	}
	const files: FileCoverage[] = [];
	for (const [file, value] of Object.entries(parsed)) {
		if (file === "total") continue;
		if (typeof value !== "object" || value === null) continue;
		const lines = (value as Record<string, unknown>).lines;
		if (typeof lines !== "object" || lines === null) continue;
		const entry = lines as Record<string, unknown>;
		if (typeof entry.pct !== "number" || typeof entry.total !== "number") continue;
		files.push({
			file,
			percent: entry.pct,
			total: entry.total,
			covered: typeof entry.covered === "number" ? entry.covered : 0,
		});
	}
	return files;
}

/**
 * Read total line coverage from a coverage.py JSON report (`--cov-report=json`).
 * The report is generated by the task's own command, so only its shape is checked.
 */
export function parseCoverageJson(text: string): number {
	const parsed: unknown = JSON.parse(text);
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error("coverage report is not a JSON object");
	}
	const totals = (parsed as Record<string, unknown>).totals;
	if (typeof totals !== "object" || totals === null) {
		throw new Error("coverage report has no totals object");
	}
	const percent = (totals as Record<string, unknown>).percent_covered;
	if (typeof percent !== "number" || !Number.isFinite(percent)) {
		throw new Error("coverage report has no numeric totals.percent_covered");
	}
	return percent;
}

function parseAttributes(source: string): Record<string, string> {
	const attributes: Record<string, string> = {};
	for (const match of source.matchAll(ATTRIBUTE_PATTERN)) {
		const name = match[1];
		if (name === undefined) continue;
		attributes[name] = decodeXml(match[2] ?? "");
	}
	return attributes;
}

function caseName(attributes: Record<string, string>): string {
	const className = attributes.classname ?? attributes.file ?? "";
	const name = attributes.name ?? "unknown";
	return className.length > 0 ? `${className}.${name}` : name;
}

function failureMessage(body: string, tag: "failure" | "error"): string {
	const opening = (tag === "failure" ? /<failure\b([^>]*)>?/ : /<error\b([^>]*)>?/).exec(body);
	if (opening) {
		const attributes = parseAttributes(opening[1] ?? "");
		const message = attributes.message;
		if (message !== undefined && message.length > 0) return message;
	}
	const text = body.replace(/<[^>]*>/g, " ").trim();
	return text.length > 0 ? text.slice(0, 300) : "no message";
}

function toCount(value: string | undefined): number {
	const parsed = Number.parseInt(value ?? "0", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function decodeXml(value: string): string {
	return value
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&apos;", "'")
		.replaceAll("&#x27;", "'")
		.replaceAll("&amp;", "&");
}
