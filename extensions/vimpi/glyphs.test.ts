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
