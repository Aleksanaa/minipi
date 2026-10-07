import assert from "node:assert/strict";
import { test } from "node:test";
import {
	clampNormal,
	deleteRange,
	findChar,
	joinLines,
	lineRange,
	matchBracket,
	put,
	textObject,
	wordBackward,
	wordEnd,
	wordForward,
} from "./motions.ts";

test("word motions", () => {
	const t = "foo.bar baz\n  qux";
	assert.equal(wordForward(t, 0, false), 3); // foo -> .
	assert.equal(wordForward(t, 3, false), 4); // . -> bar
	assert.equal(wordForward(t, 0, true), 8); // WORD skips punctuation
	assert.equal(wordForward(t, 8, false), 14); // across newline + indent
	assert.equal(wordEnd(t, 0, false), 2);
	assert.equal(wordEnd(t, 2, false), 3);
	assert.equal(wordBackward(t, 14, false), 8);
	assert.equal(wordBackward(t, 8, true), 0);
});

test("find char stays on the line", () => {
	const t = "a,b,c\nx,y";
	assert.equal(findChar(t, 0, "f", ",", 2), 3);
	assert.equal(findChar(t, 0, "t", ",", 1), 0); // adjacent target: no move, like vim
	assert.equal(findChar(t, 0, "t", ",", 1, true), 2); // ; skips the adjacent one
	assert.equal(findChar(t, 0, "f", "x", 1), undefined);
	assert.equal(findChar(t, 4, "F", ",", 1), 3);
	assert.equal(findChar(t, 4, "T", ",", 1), 4); // adjacent: no move
	assert.equal(findChar(t, 4, "T", ",", 1, true), 2);
});

test("text objects", () => {
	const t = 'say("hello world", x)';
	assert.deepEqual(textObject(t, 6, true, '"'), { start: 5, end: 16, linewise: false });
	assert.deepEqual(textObject(t, 6, false, '"'), { start: 4, end: 17, linewise: false });
	assert.deepEqual(textObject(t, 6, true, "("), { start: 4, end: 20, linewise: false });
	assert.deepEqual(textObject(t, 6, false, "b"), { start: 3, end: 21, linewise: false });
	assert.deepEqual(textObject(t, 6, true, "w"), { start: 5, end: 10, linewise: false });
	assert.deepEqual(textObject(t, 6, false, "w"), { start: 5, end: 11, linewise: false });
});

test("brackets", () => {
	assert.equal(matchBracket("f(a[1])", 0), 6);
	assert.equal(matchBracket("f(a[1])", 6), 1);
});

test("linewise delete and put", () => {
	const t = "one\ntwo\nthree";
	const d = deleteRange(t, lineRange(t, 1, 1));
	assert.equal(d.text, "one\nthree");
	assert.deepEqual(d.removed, { text: "two", linewise: true });
	const last = deleteRange(t, lineRange(t, 2, 2));
	assert.equal(last.text, "one\ntwo");
	assert.equal(last.at, 4);
	const p = put("one\nthree", 0, d.removed, true);
	assert.equal(p.text, t);
	assert.equal(p.cursor, 4);
	assert.equal(put("ac", 0, { text: "b", linewise: false }, true).text, "abc");
});

test("join and clamp", () => {
	assert.deepEqual(joinLines("foo\n   bar", 0, 2), { text: "foo bar", cursor: 3 });
	assert.equal(clampNormal("abc\n", 3), 2);
	assert.equal(clampNormal("abc\n", 4), 4);
});
