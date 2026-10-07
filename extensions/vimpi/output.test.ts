import assert from "node:assert/strict";
import { test } from "node:test";
import { attachOutput, holdOutput, releaseOutput, to8Colors } from "./output.ts";

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

test("a hold drops frames only, until release repaints", () => {
	const out: string[] = [];
	const renders: (boolean | undefined)[] = [];
	const stream = { write: (d: string) => out.push(d) > 0 };
	const hook = attachOutput(stream);
	assert.equal(attachOutput(stream), hook);
	const frame = `${E}?2026h${E}38;5;2mpi default ui${E}?2026l`;
	const setup = `${E}?1049h${E}2J`;
	const teardown = `${E}?2026h${E}?1049l${E}?25h${E}?2026l`;
	holdOutput(hook);
	stream.write(frame);
	stream.write(setup);
	stream.write(teardown);
	releaseOutput({ requestRender: (f) => void renders.push(f) }, hook);
	stream.write(frame);
	assert.deepEqual(out, [setup, teardown, `${E}?2026h${E}32mpi default ui${E}?2026l`]);
	assert.deepEqual(renders, [true]);
});
