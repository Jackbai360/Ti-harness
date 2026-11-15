/** Render run results as one self-contained HTML page. */

import type { RunResult } from "./runner.ts";

/** Render every run of one invocation into a single page. */
export function renderReport(results: readonly RunResult[], generatedAt: string): string {
	const rows = results.map((result) => renderRow(result)).join("\n");
	const passed = results.filter((result) => result.passed).length;
	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>Ti report</title>
<style>
	body { font-family: -apple-system, "Segoe UI", sans-serif; margin: 40px; color: #1f2328; }
	h1 { font-size: 20px; font-weight: 500; margin-bottom: 4px; }
	.meta { color: #656d76; font-size: 13px; margin-bottom: 24px; }
	table { border-collapse: collapse; width: 100%; font-size: 13px; }
	th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #d0d7de; vertical-align: top; }
	th { font-weight: 500; color: #656d76; }
	.pass { color: #1a7f37; font-weight: 500; }
	.fail { color: #cf222e; font-weight: 500; }
	.muted { color: #656d76; }
	details { margin-top: 4px; }
	pre { background: #f6f8fa; padding: 12px; overflow-x: auto; font-size: 12px; }
	.summary { font-size: 14px; margin-bottom: 16px; }
</style>
</head>
<body>
<h1>Ti report</h1>
<div class="meta">generated ${escapeHtml(generatedAt)} &middot; ${results.length} run(s)</div>
<div class="summary">passed <strong>${passed}</strong> / ${results.length}</div>
<table>
<thead><tr><th>task</th><th>kind</th><th>baseline</th><th>final</th><th>coverage</th><th>mutants</th><th>result</th><th>diff</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</body>
</html>
`;
}

function renderRow(result: RunResult): string {
	const verdict = result.passed ? '<span class="pass">passed</span>' : '<span class="fail">failed</span>';
	const diffLines = result.diff.length === 0 ? "no changes" : `${result.diff.split("\n").length} lines`;
	return `<tr>
	<td>${escapeHtml(result.taskId)}</td>
	<td class="muted">${escapeHtml(result.kind)}</td>
	<td>${escapeHtml(counts(result, "baseline"))}</td>
	<td>${escapeHtml(counts(result, "final"))}</td>
	<td>${escapeHtml(coverage(result))}</td>
	<td>${escapeHtml(mutants(result))}</td>
	<td>${verdict}<br><span class="muted">${Math.round(result.durationMs / 1000)}s</span></td>
	<td><details><summary>${diffLines}</summary><pre>${escapeHtml(result.diff)}</pre></details></td>
</tr>`;
}

function counts(result: RunResult, which: "baseline" | "final"): string {
	const summary = which === "baseline" ? result.baseline : result.final;
	const failures = summary.failures.map((failure) => failure.test).join(", ");
	return `${summary.failed} failed / ${summary.total}${failures.length > 0 ? `: ${failures}` : ""}`;
}

function coverage(result: RunResult): string {
	if (result.coverageBefore === null && result.coverageAfter === null) return "not measured";
	const before = result.coverageBefore === null ? "?" : `${result.coverageBefore.toFixed(1)}%`;
	const after = result.coverageAfter === null ? "?" : `${result.coverageAfter.toFixed(1)}%`;
	const target = result.coverageTarget === null ? "" : ` (target ${result.coverageTarget}%)`;
	return `${before} to ${after}${target}`;
}

function mutants(result: RunResult): string {
	if (result.mutations.length === 0) return "none";
	const killed = result.mutations.filter((mutation) => mutation.killed).length;
	const missed = result.mutations
		.filter((mutation) => !mutation.killed)
		.map((mutation) => mutation.file)
		.join(", ");
	return `${killed}/${result.mutations.length}${missed.length > 0 ? ` (missed: ${missed})` : ""}`;
}

function escapeHtml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
