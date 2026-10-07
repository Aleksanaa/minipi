import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

// ASCII plus the few glyphs verified present in both Terminus and Hack.
const ALLOWED = new Set(["─", "…", "·", "↑", "↓"]);

test("sources only use font-safe characters", () => {
	const dir = new URL(".", import.meta.url);
	const bad: string[] = [];
	for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
		readFileSync(new URL(file, dir), "utf8")
			.split("\n")
			.forEach((line, i) => {
				for (const ch of line) if (ch > "\x7f" && !ALLOWED.has(ch)) bad.push(`${file}:${i + 1} ${ch}`);
			});
	}
	assert.deepEqual(bad, []);
});

test("the theme only uses the 8 basic colors or the terminal default", () => {
	const theme = JSON.parse(readFileSync(new URL("../../themes/basic8.json", import.meta.url), "utf8"));
	const vars: Record<string, unknown> = theme.vars;
	const bad = Object.entries(theme.colors as Record<string, unknown>).filter(([, v]) => {
		const c = typeof v === "string" && v in vars ? vars[v] : v;
		return !(c === "" || (Number.isInteger(c) && (c as number) >= 0 && (c as number) <= 7));
	});
	assert.deepEqual(bad, []);
	assert.equal(theme.export, undefined);
});
