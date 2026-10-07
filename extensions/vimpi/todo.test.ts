import assert from "node:assert/strict";
import { test } from "node:test";
import { isProtected } from "./guard.ts";
import { findKeywords } from "./magic.ts";
import { applyTodo, emptyTodos, formatTodos, progress } from "./todolist.ts";

test("todo add, done, undo, remove", () => {
	let { list } = applyTodo(emptyTodos(), { action: "add", items: ["a", " b ", ""] });
	assert.deepEqual(
		list.todos.map((t) => [t.id, t.text]),
		[
			[1, "a"],
			[2, "b"],
		],
	);
	list = applyTodo(list, { action: "done", ids: [1] }).list;
	assert.deepEqual(progress(list), { done: 1, total: 2, next: { id: 2, text: "b", done: false } });
	assert.equal(formatTodos(list), "[x] 1. a\n[ ] 2. b");
	list = applyTodo(list, { action: "undo", ids: [1] }).list;
	assert.equal(progress(list).done, 0);
	list = applyTodo(list, { action: "remove", ids: [1] }).list;
	list = applyTodo(list, { action: "add", items: ["c"] }).list;
	assert.deepEqual(
		list.todos.map((t) => t.id),
		[2, 3],
	);
});

test("todo errors leave the list alone", () => {
	const { list } = applyTodo(emptyTodos(), { action: "add", items: ["a"] });
	const r = applyTodo(list, { action: "done", ids: [9] });
	assert.equal(r.error, "no todo 9");
	assert.equal(r.list, list);
	assert.equal(applyTodo(list, { action: "add" }).error, "add needs items");
	assert.equal(list.todos[0]!.done, false);
});

test("protected paths match whole segments", () => {
	for (const p of [".env", "app/.env.local", ".git/config", "/r/node_modules/x/y.js"]) assert.ok(isProtected(p), p);
	for (const p of [".envrc", "src/env.ts", ".env.example", ".github/ci.yml", "my_node_modules.md"]) assert.ok(!isProtected(p), p);
});

test("magic keywords only match prose words", () => {
	assert.deepEqual(findKeywords("ultrathink about this, tldr please"), ["ultrathink", "tldr"]);
	assert.deepEqual(findKeywords("Stepwise: fix it."), ["stepwise"]);
	assert.deepEqual(findKeywords("see `ultrathink` and src/tldr.ts or tldr-pages"), []);
	assert.deepEqual(findKeywords("```\nstepwise\n```\nultrathinking my_tldr"), []);
});
