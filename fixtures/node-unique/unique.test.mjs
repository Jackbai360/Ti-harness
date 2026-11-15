import assert from "node:assert/strict";
import { test } from "node:test";
import { unique } from "./unique.mjs";

test("keeps the first object for each key", () => {
	const users = [
		{ id: 1, name: "a" },
		{ id: 2, name: "b" },
		{ id: 1, name: "c" },
	];
	assert.deepEqual(unique(users, (user) => user.id), [
		{ id: 1, name: "a" },
		{ id: 2, name: "b" },
	]);
});

test("works without a key function", () => {
	assert.deepEqual(unique([3, 1, 3, 2]), [3, 1, 2]);
});
