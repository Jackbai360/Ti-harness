import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchAll } from "./fetchall.mjs";

const fake = async (id) => {
	await new Promise((resolve) => setTimeout(resolve, 5));
	return { id };
};

test("returns one result per id", async () => {
	const results = await fetchAll([1, 2, 3], fake);
	assert.equal(results.length, 3);
});

test("preserves input order", async () => {
	const results = await fetchAll([3, 1, 2], fake);
	assert.deepEqual(
		results.map((entry) => entry.id),
		[3, 1, 2],
	);
});
