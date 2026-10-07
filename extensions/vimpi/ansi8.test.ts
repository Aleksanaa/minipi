import assert from "node:assert/strict";
import { test } from "node:test";
import { install8Colors, to8Colors } from "./ansi8.ts";

const E = "\x1b[";

test("palette 0-7 becomes 3-bit codes", () => {
	assert.equal(to8Colors(`${E}38;5;4mx${E}39m`), `${E}34mx${E}39m`);
	assert.equal(to8Colors(`${E}1;38;5;6;48;5;4mN${E}0m`), `${E}1;36;44mN${E}0m`);
});

test("bright, 256 and truecolor collapse to the nearest basic color", () => {
	assert.equal(to8Colors(`${E}90m${E}91m${E}104m`), `${E}37m${E}31m${E}44m`);
	assert.equal(to8Colors(`${E}38;5;196m${E}38;5;21m${E}38;5;244m${E}48;5;236m`), `${E}31m${E}34m${E}37m${E}40m`);
	assert.equal(to8Colors(`${E}38;2;230;180;40m${E}48;2;30;30;40m`), `${E}33m${E}40m`);
	assert.equal(to8Colors(`${E}38:2::0:200:200m`), `${E}36m`);
});

test("non-color sequences pass through", () => {
	const s = `${E}>4;2m${E}2K${E}7m${E}8m${E}29m${E}?25l\x1b]133;A\x07`;
	assert.equal(to8Colors(s), s);
});

test("install wraps write once", () => {
	const out: string[] = [];
	const term = { write: (d: string) => void out.push(d) };
	install8Colors(term);
	install8Colors(term);
	term.write(`${E}38;5;2mok`);
	assert.deepEqual(out, [`${E}32mok`]);
});
