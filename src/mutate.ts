/** Source-level mutation operators: candidate defects used to test whether a suite would notice. */

/** One line-level rewrite: the whole line before and after the mutation. */
export interface Candidate {
	/** The original line, indentation included. Unique enough to find again with `replace`. */
	readonly find: string;
	readonly replace: string;
	/** 1-based line number in the source the candidate was found in. */
	readonly line: number;
	/** 0-based column of the rewrite inside that line. */
	readonly column: number;
	/** The operator that produced it, for logs. */
	readonly operator: string;
}

/**
 * Operator pairs as [regex source, replacement]. Only rewrites that keep the file parseable are
 * listed: comparison and equality flips, boolean joins, nullish checks, small arithmetic, and the
 * min/max swap. Narrower patterns come first so a specific rewrite wins over a general one.
 */
const OPERATORS: readonly (readonly [string, string])[] = [
	[" <= ", " < "],
	[" >= ", " > "],
	[" < ", " <= "],
	[" > ", " >= "],
	["!== null", "=== null"],
	["=== null", "!== null"],
	["!== undefined", "=== undefined"],
	["=== undefined", "!== undefined"],
	[" === ", " !== "],
	[" !== ", " === "],
	[" && ", " || "],
	[" \\|\\| ", " && "],
	[" \\?\\? ", " || "],
	["Math\\.min", "Math.max"],
	["Math\\.max", "Math.min"],
	[" \\+ 1", " - 1"],
	[" - 1", " + 1"],
	["\\btrue\\b", "false"],
	["\\bfalse\\b", "true"],
];

/**
 * Find up to `limit` candidate mutations in `source`, taking one from each operator in turn.
 * Round-robin keeps a high-frequency operator (like `true`) from crowding out the rest,
 * which matters because the caller stops after `limit` candidates.
 */
export function findCandidates(source: string, limit: number): readonly Candidate[] {
	const pools = OPERATORS.map(([pattern, replacement]) => collectMatches(source, pattern, replacement));
	const candidates: Candidate[] = [];
	const seen = new Set<string>();
	let depth = 0;
	while (candidates.length < limit) {
		let taken = false;
		for (const pool of pools) {
			if (candidates.length >= limit) break;
			const match = pool[depth];
			if (match === undefined) continue;
			taken = true;
			const candidate = lineCandidate(source, match.offset, match.length, match.replacement, match.pattern);
			if (candidate === undefined || seen.has(candidate.replace)) continue;
			seen.add(candidate.replace);
			candidates.push(candidate);
		}
		if (!taken) break;
		depth += 1;
	}
	return candidates;
}

interface Match {
	readonly offset: number;
	readonly length: number;
	readonly replacement: string;
	readonly pattern: string;
}

function collectMatches(source: string, pattern: string, replacement: string): readonly Match[] {
	const matches: Match[] = [];
	for (const match of source.matchAll(new RegExp(pattern, "g"))) {
		matches.push({ offset: match.index ?? 0, length: match[0].length, replacement, pattern });
	}
	return matches;
}

function lineCandidate(
	source: string,
	offset: number,
	length: number,
	replacement: string,
	operator: string,
): Candidate | undefined {
	const start = source.lastIndexOf("\n", offset) + 1;
	const end = source.indexOf("\n", offset);
	const lineEnd = end === -1 ? source.length : end;
	const line = source.slice(start, lineEnd);
	const column = offset - start;
	const mutated = line.slice(0, column) + replacement + line.slice(column + length);
	if (mutated === line) return undefined;
	return { find: line, replace: mutated, line: lineNumberAt(source, offset), column, operator };
}

function lineNumberAt(source: string, offset: number): number {
	let line = 1;
	for (let index = 0; index < offset; index += 1) {
		if (source.charCodeAt(index) === 10) line += 1;
	}
	return line;
}

/** How many times `text` occurs in `source`, used to reject ambiguous task mutants. */
export function countOccurrences(source: string, text: string): number {
	let count = 0;
	let offset = source.indexOf(text);
	while (offset !== -1) {
		count += 1;
		offset = source.indexOf(text, offset + text.length);
	}
	return count;
}
