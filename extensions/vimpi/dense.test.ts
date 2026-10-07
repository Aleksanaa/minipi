import assert from "node:assert/strict";
import { test } from "node:test";
import { densify, dropInventory, TOOL } from "./dense.ts";

const read = `${TOOL}* read  flake.nix        22L`;
const make = `${TOOL}! $ make              exit 2`;
const A = "\x1b]133;A\x07";
const BC = "\x1b]133;B\x07\x1b]133;C\x07";
const bg = (s: string) => `\x1b[48;5;236m${s}\x1b[49m`;

test("strips spacers but keeps paragraph breaks and prompt markers", () => {
	const input = [
		"",
		A + bg("    "),
		bg("do it"),
		BC + bg("    "),
		"",
		read,
		"",
		make,
		"  error: boom",
		"",
		"Done.",
		"",
		"- one",
		"",
		"",
	];
	assert.deepEqual(densify(input), [
		BC + A + bg("do it"),
		read,
		make,
		"  error: boom",
		"Done.",
		"",
		"- one",
	]);
});

test("resource inventory is dropped, warnings stay", () => {
	const lines = [
		"\x1b[33m[Extensions]\x1b[39m",
		"  8zn5…-vimpi",
		"",
		"[Skills]",
		"  review, deploy",
		"",
		"\x1b[33m[Extension issues]\x1b[39m",
		"  foo.ts: failed to load",
		"",
	];
	assert.deepEqual(dropInventory(lines), lines.slice(6));
});

test("indented prose after a tool block is still prose", () => {
	assert.deepEqual(densify([read, "", "text", "", "  code"]), [read, "text", "", "  code"]);
});

test("a markdown bullet is prose, not a tool row", () => {
	assert.deepEqual(densify(["Plan:", "", "* step one", "", "more"]), ["Plan:", "", "* step one", "", "more"]);
});
