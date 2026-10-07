/**
 * Pure vim text model: motions, text objects and operators over a flat
 * string with a cursor offset. No pi imports, so it can be unit-tested
 * with plain node.
 */

export interface Range {
	start: number;
	end: number; // exclusive
	linewise: boolean;
}

export interface Register {
	text: string;
	linewise: boolean;
}

interface Edit {
	text: string;
	cursor: number;
}

// ---------------------------------------------------------------------------
// Offsets and lines

export function lineStart(text: string, off: number): number {
	return text.lastIndexOf("\n", off - 1) + 1;
}

/** Offset of the newline ending this line, or text.length. */
export function lineEnd(text: string, off: number): number {
	const i = text.indexOf("\n", off);
	return i < 0 ? text.length : i;
}

export function lineIndex(text: string, off: number): number {
	let n = 0;
	for (let i = text.indexOf("\n"); i >= 0 && i < off; i = text.indexOf("\n", i + 1)) n++;
	return n;
}

export function lineCount(text: string): number {
	let n = 1;
	for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) n++;
	return n;
}

export function offsetOfLine(text: string, line: number): number {
	let off = 0;
	for (let i = 0; i < line; i++) {
		const nl = text.indexOf("\n", off);
		if (nl < 0) return off;
		off = nl + 1;
	}
	return off;
}

export function toOffset(lines: string[], line: number, col: number): number {
	let off = 0;
	for (let i = 0; i < line && i < lines.length; i++) off += lines[i]!.length + 1;
	return off + col;
}

export function toLineCol(text: string, off: number): { line: number; col: number } {
	return { line: lineIndex(text, off), col: off - lineStart(text, off) };
}

/** Step one code point forward/backward (keeps surrogate pairs together). */
export function nextChar(text: string, off: number): number {
	if (off >= text.length) return text.length;
	const cp = text.codePointAt(off)!;
	return off + (cp > 0xffff ? 2 : 1);
}

export function prevChar(text: string, off: number): number {
	if (off <= 0) return 0;
	const lo = text.charCodeAt(off - 1);
	if (off >= 2 && lo >= 0xdc00 && lo <= 0xdfff) {
		const hi = text.charCodeAt(off - 2);
		if (hi >= 0xd800 && hi <= 0xdbff) return off - 2;
	}
	return off - 1;
}

/** Clamp to a valid normal-mode position: on a character, never on the newline. */
export function clampNormal(text: string, off: number): number {
	off = Math.max(0, Math.min(off, text.length));
	const ls = lineStart(text, off);
	const le = lineEnd(text, off);
	if (le === ls) return ls;
	return off >= le ? prevChar(text, le) : off;
}

export function firstNonBlank(text: string, off: number): number {
	const ls = lineStart(text, off);
	const le = lineEnd(text, off);
	let p = ls;
	while (p < le && (text[p] === " " || text[p] === "\t")) p++;
	return p;
}

// ---------------------------------------------------------------------------
// Character classes

const WORD_RE = /[\p{L}\p{N}_]/u;

/** 0 = blank (incl. newline), 1 = word, 2 = punctuation. With big=true, punctuation counts as word. */
export function charClass(ch: string | undefined, big = false): number {
	if (ch === undefined || ch === " " || ch === "\t" || ch === "\n") return 0;
	if (big) return 1;
	return WORD_RE.test(ch) ? 1 : 2;
}

function cls(text: string, off: number, big: boolean): number {
	if (off < 0 || off >= text.length) return 0;
	return charClass(String.fromCodePoint(text.codePointAt(off)!), big);
}

// ---------------------------------------------------------------------------
// Word motions

export function wordForward(text: string, off: number, big: boolean): number {
	const len = text.length;
	if (off >= len) return len;
	const c = cls(text, off, big);
	let p = off;
	if (c !== 0) while (p < len && cls(text, p, big) === c) p = nextChar(text, p);
	// Skip blanks, but stop on an empty line (vim treats it as a word).
	while (p < len && cls(text, p, big) === 0) {
		if (text[p] === "\n" && p + 1 < len && text[p + 1] === "\n" && p + 1 !== off) return p + 1;
		p = nextChar(text, p);
	}
	return p;
}

export function wordEnd(text: string, off: number, big: boolean): number {
	const len = text.length;
	let p = nextChar(text, off);
	while (p < len && cls(text, p, big) === 0) p = nextChar(text, p);
	if (p >= len) return Math.max(0, prevChar(text, len));
	const c = cls(text, p, big);
	for (let n = nextChar(text, p); n < len && cls(text, n, big) === c; n = nextChar(text, n)) p = n;
	return p;
}

export function wordBackward(text: string, off: number, big: boolean): number {
	let p = prevChar(text, off);
	while (p > 0 && cls(text, p, big) === 0) p = prevChar(text, p);
	const c = cls(text, p, big);
	if (c === 0) return p;
	while (p > 0) {
		const q = prevChar(text, p);
		if (cls(text, q, big) !== c) break;
		p = q;
	}
	return p;
}

// ---------------------------------------------------------------------------
// Character search within the line (f F t T)

export type FindKind = "f" | "F" | "t" | "T";

/** `repeat` (from ; and ,) makes t/T skip an adjacent match so they do not get stuck. */
export function findChar(text: string, off: number, kind: FindKind, ch: string, count: number, repeat = false): number | undefined {
	const ls = lineStart(text, off);
	const le = lineEnd(text, off);
	let p = off;
	for (let i = 0; i < count; i++) {
		const skip = (kind === "t" || kind === "T") && (repeat || i > 0) ? 1 : 0;
		if (kind === "f" || kind === "t") {
			const idx = text.indexOf(ch, p + 1 + skip);
			if (idx < 0 || idx >= le) return undefined;
			p = kind === "t" ? idx - 1 : idx;
		} else {
			const from = p - 1 - skip;
			if (from < ls) return undefined;
			const idx = text.lastIndexOf(ch, from);
			if (idx < ls) return undefined;
			p = kind === "T" ? idx + 1 : idx;
		}
	}
	return p;
}

// ---------------------------------------------------------------------------
// Brackets

const PAIRS: Record<string, [string, string]> = {
	"(": ["(", ")"],
	")": ["(", ")"],
	b: ["(", ")"],
	"[": ["[", "]"],
	"]": ["[", "]"],
	"{": ["{", "}"],
	"}": ["{", "}"],
	B: ["{", "}"],
	"<": ["<", ">"],
	">": ["<", ">"],
};

export function matchBracket(text: string, off: number): number | undefined {
	const le = lineEnd(text, off);
	let p = off;
	while (p < le && !"()[]{}".includes(text[p]!)) p++;
	if (p >= le) return undefined;
	const ch = text[p]!;
	const [open, close] = PAIRS[ch]!;
	const forward = ch === open;
	let depth = 0;
	for (let i = p; forward ? i < text.length : i >= 0; i += forward ? 1 : -1) {
		if (text[i] === open) depth += forward ? 1 : -1;
		else if (text[i] === close) depth += forward ? -1 : 1;
		if (depth === 0) return i;
	}
	return undefined;
}

function enclosingPair(text: string, off: number, open: string, close: string): [number, number] | undefined {
	let depth = 0;
	let start = -1;
	// When the cursor sits on the opening bracket, that bracket is the pair.
	if (text[off] === open) start = off;
	else {
		for (let i = text[off] === close ? off - 1 : off; i >= 0; i--) {
			if (text[i] === close) depth++;
			else if (text[i] === open) {
				if (depth === 0) {
					start = i;
					break;
				}
				depth--;
			}
		}
	}
	if (start < 0) return undefined;
	depth = 0;
	for (let i = start; i < text.length; i++) {
		if (text[i] === open) depth++;
		else if (text[i] === close) {
			depth--;
			if (depth === 0) return [start, i];
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Text objects (iw aw iW aW i" a" i( a( ...)

export function textObject(text: string, off: number, inner: boolean, obj: string, count = 1): Range | undefined {
	if (obj === "w" || obj === "W") {
		const big = obj === "W";
		const ls = lineStart(text, off);
		const le = lineEnd(text, off);
		if (ls === le) return undefined;
		let start = off;
		let end = off;
		for (let n = 0; n < count; n++) {
			const c = cls(text, end, big);
			if (n === 0) while (start > ls && cls(text, prevChar(text, start), big) === c) start = prevChar(text, start);
			while (end < le && cls(text, end, big) === c) end = nextChar(text, end);
			if (!inner) {
				if (c !== 0) {
					const before = end;
					while (end < le && cls(text, end, big) === 0) end = nextChar(text, end);
					// No trailing blanks: take the leading ones instead.
					if (end === before) while (start > ls && cls(text, prevChar(text, start), big) === 0) start = prevChar(text, start);
				} else {
					const c2 = cls(text, end, big);
					while (end < le && cls(text, end, big) === c2 && c2 !== 0) end = nextChar(text, end);
				}
			}
		}
		return { start, end, linewise: false };
	}
	if (obj === '"' || obj === "'" || obj === "`") {
		const ls = lineStart(text, off);
		const le = lineEnd(text, off);
		const quotes: number[] = [];
		for (let i = ls; i < le; i++) if (text[i] === obj && text[i - 1] !== "\\") quotes.push(i);
		for (let i = 0; i + 1 < quotes.length; i += 2) {
			const a = quotes[i]!;
			const b = quotes[i + 1]!;
			if (off <= b) {
				if (inner) return { start: a + 1, end: b, linewise: false };
				let end = b + 1;
				while (end < le && (text[end] === " " || text[end] === "\t")) end++;
				return { start: a, end, linewise: false };
			}
		}
		return undefined;
	}
	const pair = PAIRS[obj];
	if (pair) {
		let range = enclosingPair(text, off, pair[0], pair[1]);
		for (let n = 1; n < count && range; n++) range = range[0] > 0 ? enclosingPair(text, range[0] - 1, pair[0], pair[1]) : undefined;
		if (!range) return undefined;
		const [a, b] = range;
		return inner ? { start: a + 1, end: b, linewise: false } : { start: a, end: b + 1, linewise: false };
	}
	if (obj === "p") {
		// Paragraph: run of non-empty lines (inner) plus trailing blank lines (a).
		const isBlank = (l: number) => {
			const s = offsetOfLine(text, l);
			return lineEnd(text, s) === s;
		};
		const total = lineCount(text);
		let l1 = lineIndex(text, off);
		let l2 = l1;
		const blank = isBlank(l1);
		while (l1 > 0 && isBlank(l1 - 1) === blank) l1--;
		while (l2 + 1 < total && isBlank(l2 + 1) === blank) l2++;
		if (!inner) while (l2 + 1 < total && isBlank(l2 + 1) !== blank) l2++;
		return lineRange(text, l1, l2);
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Ranges and operators

export function lineRange(text: string, l1: number, l2: number): Range {
	const start = offsetOfLine(text, Math.min(l1, l2));
	const end = lineEnd(text, offsetOfLine(text, Math.max(l1, l2)));
	return { start, end, linewise: true };
}

/** Remove a range; linewise ranges also remove one adjoining newline. */
export function deleteRange(text: string, r: Range): { text: string; removed: Register; at: number } {
	if (!r.linewise) {
		return {
			text: text.slice(0, r.start) + text.slice(r.end),
			removed: { text: text.slice(r.start, r.end), linewise: false },
			at: r.start,
		};
	}
	const removed = { text: text.slice(r.start, r.end), linewise: true };
	if (r.end < text.length) return { text: text.slice(0, r.start) + text.slice(r.end + 1), removed, at: r.start };
	if (r.start > 0) {
		const t = text.slice(0, r.start - 1);
		return { text: t, removed, at: lineStart(t, t.length) };
	}
	return { text: "", removed, at: 0 };
}

export function put(text: string, off: number, reg: Register, after: boolean, count = 1): Edit {
	if (reg.linewise) {
		const block = Array(count).fill(reg.text).join("\n");
		if (after) {
			const le = lineEnd(text, off);
			const t = `${text.slice(0, le)}\n${block}${text.slice(le)}`;
			return { text: t, cursor: firstNonBlank(t, le + 1) };
		}
		const ls = lineStart(text, off);
		const t = `${text.slice(0, ls)}${block}\n${text.slice(ls)}`;
		return { text: t, cursor: firstNonBlank(t, ls) };
	}
	const block = reg.text.repeat(count);
	const at = after && off < lineEnd(text, off) ? nextChar(text, off) : off;
	const t = text.slice(0, at) + block + text.slice(at);
	return { text: t, cursor: Math.max(at, prevChar(t, at + block.length)) };
}

export function joinLines(text: string, off: number, count: number): Edit {
	let t = text;
	let cursor = off;
	for (let i = 0; i < Math.max(1, count - 1); i++) {
		const le = lineEnd(t, cursor);
		if (le >= t.length) break;
		let next = le + 1;
		while (next < t.length && (t[next] === " " || t[next] === "\t")) next++;
		let prevEnd = le;
		while (prevEnd > lineStart(t, le) && (t[prevEnd - 1] === " " || t[prevEnd - 1] === "\t")) prevEnd--;
		const sep = next < t.length && t[next] !== "\n" && t[next] !== ")" && prevEnd > lineStart(t, le) ? " " : "";
		t = t.slice(0, prevEnd) + sep + t.slice(next);
		cursor = prevEnd;
	}
	return { text: t, cursor };
}

export function toggleCase(s: string): string {
	let out = "";
	for (const ch of s) {
		const up = ch.toUpperCase();
		out += ch === up ? ch.toLowerCase() : up;
	}
	return out;
}
