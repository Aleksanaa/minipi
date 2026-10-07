/**
 * Modal prompt editor.
 *
 * Insert mode is pi's normal editor. Normal mode implements vim motions,
 * operators, text objects, counts, registers, undo/redo and dot-repeat over
 * the prompt buffer. Keys that have nowhere to go inside the buffer "spill
 * over" to the transcript: j/k at the first/last line scroll it, and gg/G
 * jump to its ends when the prompt is a single line.
 *
 * The two editor borders double as the status line, so pi's header and
 * footer can be hidden entirely.
 */

import { CustomEditor, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import {
	decodeKittyPrintable,
	type EditorTheme,
	type KeyId,
	matchesKey,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { applyDense, hideResourceListing, removeDense } from "./dense.ts";
import {
	charClass,
	clampNormal,
	deleteRange,
	type FindKind,
	findChar,
	firstNonBlank,
	joinLines,
	lineCount,
	lineEnd,
	lineIndex,
	lineRange,
	lineStart,
	matchBracket,
	nextChar,
	offsetOfLine,
	prevChar,
	put,
	type Range,
	type Register,
	textObject,
	toggleCase,
	toLineCol,
	toOffset,
	wordBackward,
	wordEnd,
	wordForward,
} from "./motions.ts";
import { borderRow, fmtTokens, type Seg, shortModel, state, thinkingTag } from "./status.ts";
import { toggleTodos } from "./todo.ts";
import { completeCommand, EX_ALIASES, LEADER, type LeaderEntry, showHelp, whichKeyWidget } from "./ui.ts";

export type Mode = "insert" | "normal" | "cmdline";

const MORE = Symbol("more");
const BAD = Symbol("bad");
type Step = typeof MORE | typeof BAD | void;

interface Motion {
	to: number;
	inclusive?: boolean;
	linewise?: boolean;
}

const CTRL = "abcdefghijklmnopqrstuvwxyz";
const NAMED: [KeyId, string][] = [
	["escape", "<Esc>"],
	["enter", "<CR>"],
	["backspace", "<BS>"],
	["tab", "<Tab>"],
	["left", "<Left>"],
	["right", "<Right>"],
	["up", "<Up>"],
	["down", "<Down>"],
];

/** Normalize raw terminal input to a vim-style key token, or undefined for keys we never interpret. */
export function tokenize(data: string): string | undefined {
	for (const [id, tok] of NAMED) if (matchesKey(data, id)) return tok;
	for (const c of CTRL) if (matchesKey(data, `ctrl+${c}` as KeyId)) return `<C-${c}>`;
	if (!data.startsWith("\x1b") && [...data].length === 1 && data >= " " && data !== "\x7f") return data;
	return decodeKittyPrintable(data);
}

const OPERATORS = new Set(["d", "c", "y"]);

export class VimEditor extends CustomEditor {
	mode: Mode = "insert";
	private keys: string[] = [];
	private reg: Register = { text: "", linewise: false };
	private lastFind?: { kind: FindKind; ch: string };
	private curswant?: number;
	private redoStack: { text: string; cursor: number }[] = [];
	private dot?: { keys: string[]; insert: string[] };
	private recording?: { keys: string[]; insert: string[] };
	private replaying = false;
	private leader = false;
	private cmd = "";
	private cmdHist: string[] = [];
	private cmdHistIdx = -1;
	private tabBase?: string;
	private tabIdx = 0;
	private flash?: { text: string; error: boolean };
	/** Undo depth before the command that entered insert mode; see collapseUndo. */
	private insertUndoMark?: number;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
		super(tui, theme, keybindings, { embedWorkingStatus: true });
	}

	private get ui() {
		return state.ctx?.ui;
	}

	private get piTheme(): Theme | undefined {
		return state.ctx?.ui.theme;
	}

	// -----------------------------------------------------------------------
	// Buffer access. Editor keeps `state` private; we use it (with fallbacks)
	// so edits keep pi's paste markers and undo stack intact.

	// biome-ignore lint/suspicious/noExplicitAny: reaching into Editor internals
	private get raw(): any {
		return this;
	}

	private cursor(): number {
		const c = this.getCursor();
		return toOffset(this.getLines(), c.line, c.col);
	}

	private moveTo(off: number): void {
		const { line, col } = toLineCol(this.getText(), off);
		const s = this.raw.state;
		if (s) {
			s.cursorLine = line;
			if (typeof this.raw.setCursorCol === "function") this.raw.setCursorCol(col);
			else s.cursorCol = col;
		}
		this.tui.requestRender();
	}

	private commit(text: string, cursor: number, keepRedo = false): void {
		if (text !== this.getText()) {
			const s = this.raw.state;
			if (s && typeof this.raw.pushUndoSnapshot === "function") {
				this.raw.cancelAutocomplete?.();
				this.raw.exitHistoryBrowsing?.();
				this.raw.pushUndoSnapshot();
				this.raw.lastAction = null;
				s.lines = text.split("\n");
				this.onChange?.(text);
			} else {
				this.setText(text);
			}
			if (!keepRedo) this.redoStack = [];
		}
		this.moveTo(cursor);
	}

	// -----------------------------------------------------------------------
	// Mode switching

	setMode(mode: Mode): void {
		if (this.mode === mode) return;
		this.mode = mode;
		this.keys = [];
		this.setLeader(false);
		if (mode !== "cmdline") this.ui?.setWidget("vimpi", undefined);
		this.tui.requestRender();
	}

	private enterInsert(at: number): void {
		this.moveTo(at);
		this.setMode("insert");
	}

	private leaveInsert(): void {
		const t = this.getText();
		const p = this.cursor();
		this.setMode("normal");
		this.moveTo(clampNormal(t, p > lineStart(t, p) ? prevChar(t, p) : p));
		if (this.recording) {
			if (!this.replaying) this.dot = this.recording;
			this.recording = undefined;
		}
		this.collapseUndo();
	}

	private undoDepth(): number | undefined {
		const st = this.raw.undoStack?.stack;
		return Array.isArray(st) ? st.length : undefined;
	}

	/** Like vim, one `u` undoes a whole change including the text typed in insert mode. */
	private collapseUndo(): void {
		const mark = this.insertUndoMark;
		this.insertUndoMark = undefined;
		const st = this.raw.undoStack?.stack;
		if (mark !== undefined && Array.isArray(st) && st.length > mark + 1) st.splice(mark + 1);
	}

	private setLeader(on: boolean): void {
		if (this.leader === on) return;
		this.leader = on;
		this.ui?.setWidget("vimpi", on ? whichKeyWidget(LEADER) : undefined);
	}

	private say(text: string, error = false): void {
		this.flash = { text, error };
		this.tui.requestRender();
	}

	// -----------------------------------------------------------------------
	// Input

	handleInput(data: string): void {
		if (this.mode === "insert") {
			if (matchesKey(data, "escape")) {
				if (this.isShowingAutocomplete()) super.handleInput(data);
				this.leaveInsert();
				return;
			}
			this.recording?.insert.push(data);
			super.handleInput(data);
			return;
		}
		const tok = tokenize(data);
		this.flash = undefined;
		if (this.mode === "cmdline") {
			this.cmdlineKey(tok);
			return;
		}
		if (this.leader) {
			this.setLeader(false);
			const entry = LEADER.find((e) => e.key === tok);
			if (entry) this.runLeader(entry);
			return;
		}
		if (tok === undefined) {
			super.handleInput(data);
			return;
		}
		if (this.keys.length === 0) {
			switch (tok) {
				case "<Esc>":
					super.handleInput(data); // abort agent / double-escape tree
					return;
				case "<CR>":
					if (this.getText().trim()) this.submit();
					return;
				case " ":
					this.setLeader(true);
					return;
				case ":":
					this.openCmdline("");
					return;
				case "/":
				case "?":
					this.transcript("search");
					return;
				case "<Up>":
				case "<Down>":
					super.handleInput(data); // prompt history
					return;
			}
			if (tok.startsWith("<C-") && !["<C-e>", "<C-y>", "<C-d>", "<C-u>", "<C-f>", "<C-b>", "<C-r>"].includes(tok)) {
				super.handleInput(data);
				return;
			}
		}
		if (tok === "<Esc>") {
			this.keys = [];
			this.tui.requestRender();
			return;
		}
		this.keys.push(tok);
		const keys = this.keys;
		const mark = this.undoDepth();
		const res = this.exec(keys);
		if ((this.mode as Mode) === "insert") this.insertUndoMark = mark; // exec may have switched mode
		if (res === MORE) {
			this.tui.requestRender();
			return;
		}
		this.keys = [];
		if (res === BAD) this.say(`?${keys.join("")}`, true);
		this.tui.requestRender();
	}

	private submit(): void {
		this.setMode("insert");
		super.handleInput("\r");
	}

	// -----------------------------------------------------------------------
	// Normal-mode command parser/executor. Returns MORE when keys are a valid
	// prefix, BAD when they can never form a command.

	private exec(keys: string[]): Step {
		let i = 0;
		const count = (): number | undefined => {
			let s = "";
			while (i < keys.length && /^[0-9]$/.test(keys[i]!) && !(s === "" && keys[i] === "0")) s += keys[i++];
			return s ? Number.parseInt(s, 10) : undefined;
		};
		const c1 = count();
		if (i >= keys.length) return MORE;
		const k = keys[i++]!;
		const n = c1 ?? 1;
		const text = this.getText();
		const p = this.cursor();

		if (OPERATORS.has(k) || (k === "g" && ["~", "u", "U"].includes(keys[i] ?? ""))) {
			const op = k === "g" ? `g${keys[i++]}` : k;
			const c2 = count();
			if (i >= keys.length) return MORE;
			const total = (c1 ?? 1) * (c2 ?? 1);
			const m = keys[i]!;
			let range: Range | undefined;
			if (m === k || (op.startsWith("g") && (m === op[1] || m === "g"))) {
				if (op.startsWith("g") && m === "g" && keys[i + 1] === undefined) return MORE;
				const l = lineIndex(text, p);
				if (l + total - 1 >= lineCount(text) && total > 1) return BAD;
				range = lineRange(text, l, Math.min(lineCount(text) - 1, l + total - 1));
			} else if (m === "i" || m === "a") {
				if (i + 1 >= keys.length) return MORE;
				range = textObject(text, p, m === "i", keys[i + 1]!, total);
				if (!range) return BAD;
			} else {
				// cw on a word behaves like ce (vim compatibility)
				const motionKeys = op === "c" && (m === "w" || m === "W") && charClass(text[p]) !== 0 ? [m === "w" ? "e" : "E"] : keys.slice(i);
				const mo = this.motion(motionKeys, 0, total, true);
				if (mo === MORE || mo === BAD) return mo;
				if (!mo) return BAD;
				range = this.rangeTo(p, mo);
				if (m === "w" || m === "W") {
					// dw on the last word of a line stops at the line end
					const seg = text.slice(range.start, range.end);
					if (seg.includes("\n") && !range.linewise) range.end = Math.max(range.start, lineEnd(text, range.start));
				}
			}
			this.operate(op, range, p);
			if (op !== "y") this.record(keys, op === "c");
			return;
		}

		switch (k) {
			case "i":
				this.record(keys, true);
				this.enterInsert(p);
				return;
			case "a":
				this.record(keys, true);
				this.enterInsert(p < lineEnd(text, p) ? nextChar(text, p) : p);
				return;
			case "I":
				this.record(keys, true);
				this.enterInsert(firstNonBlank(text, p));
				return;
			case "A":
				this.record(keys, true);
				this.enterInsert(lineEnd(text, p));
				return;
			case "o":
			case "O": {
				this.record(keys, true);
				const at = k === "o" ? lineEnd(text, p) : lineStart(text, p);
				this.commit(`${text.slice(0, at)}\n${text.slice(at)}`, k === "o" ? at + 1 : at);
				this.setMode("insert");
				return;
			}
			case "x":
			case "X":
			case "D":
			case "C":
			case "s":
			case "S":
			case "Y": {
				const map: Record<string, string[]> = {
					x: ["d", "l"],
					X: ["d", "h"],
					D: ["d", "$"],
					C: ["c", "$"],
					s: ["c", "l"],
					S: ["c", "c"],
					Y: ["y", "y"],
				};
				if ((k === "x" || k === "s") && lineEnd(text, p) === lineStart(text, p)) return k === "s" ? this.exec(["i"]) : BAD;
				return this.exec([...(c1 ? String(c1).split("") : []), ...map[k]!]);
			}
			case "p":
			case "P": {
				if (!this.reg.text && !this.reg.linewise) return BAD;
				const e = put(text, p, this.reg, k === "p", n);
				this.commit(e.text, clampNormal(e.text, e.cursor));
				this.record(keys);
				return;
			}
			case "J": {
				const e = joinLines(text, p, Math.max(2, n));
				this.commit(e.text, clampNormal(e.text, e.cursor));
				this.record(keys);
				return;
			}
			case "r": {
				if (i >= keys.length) return MORE;
				const ch = keys[i]!;
				if (ch.length > 2 && ch.startsWith("<")) return ch === "<CR>" ? this.replaceWithNewline(text, p) : BAD;
				let end = p;
				for (let j = 0; j < n; j++) {
					if (end >= lineEnd(text, p)) return BAD;
					end = nextChar(text, end);
				}
				const t = text.slice(0, p) + ch.repeat(n) + text.slice(end);
				this.commit(t, p + ch.length * n - ch.length);
				this.record(keys);
				return;
			}
			case "~": {
				let end = p;
				for (let j = 0; j < n && end < lineEnd(text, p); j++) end = nextChar(text, end);
				const t = text.slice(0, p) + toggleCase(text.slice(p, end)) + text.slice(end);
				this.commit(t, clampNormal(t, end));
				this.record(keys);
				return;
			}
			case "u":
				for (let j = 0; j < n; j++) this.undoOnce();
				return;
			case "<C-r>":
				for (let j = 0; j < n; j++) this.redoOnce();
				return;
			case ".":
				for (let j = 0; j < n; j++) this.repeatDot();
				return;
			case "Z":
				if (i >= keys.length) return MORE;
				if (keys[i] === "Z" || keys[i] === "Q") {
					this.ex("q");
					return;
				}
				return BAD;
			case "[":
			case "]":
				if (i >= keys.length) return MORE;
				if (keys[i] !== k) return BAD;
				for (let j = 0; j < n; j++) this.transcript(k === "[" ? "prevPrompt" : "nextPrompt");
				return;
			case "<C-e>":
			case "<C-y>":
				this.transcript("scroll", (k === "<C-e>" ? 1 : -1) * n);
				return;
			case "<C-d>":
			case "<C-u>":
			case "<C-f>":
			case "<C-b>": {
				const rows = this.tui.terminal.rows;
				const page = k === "<C-d>" || k === "<C-u>" ? Math.max(1, Math.floor(rows / 2)) : Math.max(1, rows - 2);
				this.transcript("scroll", (k === "<C-d>" || k === "<C-f>" ? 1 : -1) * page * n);
				return;
			}
		}

		// Plain motion
		const mo = this.motion(keys, i - 1, n, false, c1 !== undefined);
		if (mo === MORE || mo === BAD) return mo;
		if (!mo) return;
		this.moveTo(clampNormal(text, mo.to));
		if (!["j", "k", "<Down>", "<Up>", "+", "-", "_"].includes(k)) this.curswant = undefined;
	}

	private replaceWithNewline(text: string, p: number): Step {
		if (p >= lineEnd(text, p)) return BAD;
		const t = `${text.slice(0, p)}\n${text.slice(nextChar(text, p))}`;
		this.commit(t, p + 1);
		return;
	}

	/**
	 * Parse a motion starting at keys[i]. Returns undefined when the motion
	 * was consumed by spilling over to the transcript.
	 */
	private motion(keys: string[], i: number, n: number, forOp: boolean, explicitCount = false): Motion | typeof MORE | typeof BAD | undefined {
		const text = this.getText();
		const p = this.cursor();
		const k = keys[i];
		if (k === undefined) return MORE;
		const ls = lineStart(text, p);
		const le = lineEnd(text, p);
		const repeat = (f: (o: number) => number) => {
			let o = p;
			for (let j = 0; j < n; j++) o = f(o);
			return o;
		};
		switch (k) {
			case "h":
			case "<Left>":
			case "<BS>":
				return { to: Math.max(ls, repeat((o) => (o > ls ? prevChar(text, o) : o))) };
			case "l":
			case "<Right>": {
				const to = repeat((o) => (o < le ? nextChar(text, o) : o));
				return { to: forOp ? to : Math.min(to, le > ls ? prevChar(text, le) : ls) };
			}
			case "0":
				return { to: ls };
			case "^":
				return { to: firstNonBlank(text, p) };
			case "$": {
				const target = lineEnd(text, offsetOfLine(text, Math.min(lineCount(text) - 1, lineIndex(text, p) + n - 1)));
				return forOp ? { to: target } : { to: clampNormal(text, target) };
			}
			case "w":
			case "W":
				return { to: repeat((o) => wordForward(text, o, k === "W")) };
			case "b":
			case "B":
				return { to: repeat((o) => wordBackward(text, o, k === "B")) };
			case "e":
			case "E":
				return { to: repeat((o) => wordEnd(text, o, k === "E")), inclusive: true };
			case "%": {
				const to = matchBracket(text, p);
				return to === undefined ? BAD : { to, inclusive: true };
			}
			case "f":
			case "F":
			case "t":
			case "T":
			case ";":
			case ",": {
				let kind: FindKind;
				let ch: string;
				if (k === ";" || k === ",") {
					if (!this.lastFind) return BAD;
					({ kind, ch } = this.lastFind);
					if (k === ",") kind = ({ f: "F", F: "f", t: "T", T: "t" } as const)[kind];
				} else {
					if (i + 1 >= keys.length) return MORE;
					kind = k;
					ch = keys[i + 1]!;
					if (ch.length > 1) return BAD;
					this.lastFind = { kind, ch };
				}
				const to = findChar(text, p, kind, ch, n, k === ";" || k === ",");
				return to === undefined ? BAD : { to, inclusive: kind === "f" || kind === "t" };
			}
			case "j":
			case "k":
			case "<Down>":
			case "<Up>":
			case "+":
			case "-":
			case "_": {
				const dir = k === "j" || k === "<Down>" || k === "+" ? 1 : k === "_" ? 0 : -1;
				const cur = lineIndex(text, p);
				const last = lineCount(text) - 1;
				const want = k === "_" ? cur + n - 1 : cur + dir * n;
				const target = Math.max(0, Math.min(last, want));
				if (target === cur && dir !== 0) {
					if (forOp) return BAD;
					// Nothing to move to inside the prompt: scroll the transcript instead.
					this.transcript("scroll", dir * n);
					return undefined;
				}
				const start = offsetOfLine(text, target);
				if (k === "+" || k === "-" || k === "_") return { to: firstNonBlank(text, start), linewise: true };
				this.curswant ??= p - ls;
				return { to: Math.min(start + this.curswant, lineEnd(text, start)), linewise: true };
			}
			case "G":
			case "g": {
				if (k === "g") {
					if (i + 1 >= keys.length) return MORE;
					const k2 = keys[i + 1];
					if (k2 === "e" || k2 === "E") {
						const big = k2 === "E";
						return {
							to: repeat((o) => {
								let q = o;
								const c = charClass(text[q], big);
								while (q > 0 && c !== 0 && charClass(text[q], big) === c) q = prevChar(text, q);
								while (q > 0 && charClass(text[q], big) === 0) q = prevChar(text, q);
								return q;
							}),
							inclusive: true,
						};
					}
					if (k2 !== "g") return BAD;
				}
				const last = lineCount(text) - 1;
				if (!forOp && last === 0 && !explicitCount) {
					this.transcript(k === "G" ? "bottom" : "top");
					return undefined;
				}
				const line = explicitCount ? Math.min(last, n - 1) : k === "G" ? last : 0;
				return { to: firstNonBlank(text, offsetOfLine(text, line)), linewise: true };
			}
		}
		return BAD;
	}

	private rangeTo(p: number, m: Motion): Range {
		const text = this.getText();
		if (m.linewise) {
			const a = lineIndex(text, p);
			const b = lineIndex(text, m.to);
			return lineRange(text, Math.min(a, b), Math.max(a, b));
		}
		const start = Math.min(p, m.to);
		let end = Math.max(p, m.to);
		if (m.inclusive) end = nextChar(text, end);
		return { start, end, linewise: false };
	}

	private operate(op: string, r: Range, p: number): void {
		const text = this.getText();
		const slice = text.slice(r.start, r.end);
		switch (op) {
			case "y": {
				this.reg = { text: slice, linewise: r.linewise };
				const lines = r.linewise ? slice.split("\n").length : 0;
				if (lines > 1) this.say(`${lines} lines yanked`);
				this.moveTo(r.linewise ? (lineIndex(text, r.start) === lineIndex(text, p) ? p : r.start) : r.start);
				return;
			}
			case "d": {
				const d = deleteRange(text, r);
				this.reg = d.removed;
				this.commit(d.text, r.linewise ? firstNonBlank(d.text, d.at) : clampNormal(d.text, d.at));
				return;
			}
			case "c": {
				this.reg = { text: slice, linewise: r.linewise };
				const t = text.slice(0, r.start) + text.slice(r.end);
				this.commit(t, r.start);
				this.setMode("insert");
				return;
			}
			case "g~":
			case "gu":
			case "gU": {
				const f = op === "g~" ? toggleCase : op === "gu" ? (s: string) => s.toLowerCase() : (s: string) => s.toUpperCase();
				const t = text.slice(0, r.start) + f(slice) + text.slice(r.end);
				this.commit(t, clampNormal(t, r.start));
				return;
			}
		}
	}

	// -----------------------------------------------------------------------
	// Undo / redo / dot

	private undoOnce(): void {
		const before = { text: this.getText(), cursor: this.cursor() };
		if (typeof this.raw.undo !== "function") return;
		this.raw.undo();
		if (this.getText() === before.text) {
			this.say("Already at oldest change");
			return;
		}
		this.redoStack.push(before);
		const t = this.getText();
		this.moveTo(clampNormal(t, this.cursor()));
	}

	private redoOnce(): void {
		const r = this.redoStack.pop();
		if (!r) {
			this.say("Already at newest change");
			return;
		}
		this.commit(r.text, clampNormal(r.text, r.cursor), true);
	}

	private record(keys: string[], entersInsert = false): void {
		if (this.replaying) return;
		const rec = { keys: [...keys], insert: [] as string[] };
		if (entersInsert) this.recording = rec;
		else this.dot = rec;
	}

	private repeatDot(): void {
		const d = this.dot;
		if (!d) return;
		this.replaying = true;
		try {
			const mark = this.undoDepth();
			this.exec(d.keys);
			if (this.mode === "insert") {
				this.insertUndoMark = mark;
				for (const data of d.insert) super.handleInput(data);
				this.leaveInsert();
			}
		} finally {
			this.replaying = false;
		}
	}

	// -----------------------------------------------------------------------
	// Transcript (fullscreen viewport) control

	private transcript(action: "scroll" | "top" | "bottom" | "prevPrompt" | "nextPrompt" | "search", lines = 0): void {
		// biome-ignore lint/suspicious/noExplicitAny: TuiAltScreen API, absent in regular mode
		const t = this.tui as any;
		if (typeof t.scrollBy !== "function") {
			this.say("transcript nav needs --tui-mode fullscreen", true);
			return;
		}
		if (action === "scroll") t.scrollBy(lines);
		else if (action === "top") t.scrollToTop();
		else if (action === "bottom") t.scrollToBottom();
		else if (action === "search") t.toggleSearch?.();
		else t.scrollToPrompt?.(action === "prevPrompt" ? -1 : 1);
	}

	// -----------------------------------------------------------------------
	// Leader and ex commands

	private runLeader(e: LeaderEntry): void {
		if (e.action) this.actionHandlers.get(e.action)?.();
		else if (e.slash) this.slash(e.slash);
		else if (e.run === "help") showHelp();
		else if (e.run === "pasteImage") this.onPasteImage?.();
		else if (e.run === "density") this.setDensity(state.density === "dense" ? "compact" : "dense");
		else if (e.run === "todos") toggleTodos();
	}

	/** Run a pi slash command without losing the draft in the buffer. */
	slash(cmd: string): void {
		const draft = this.getExpandedText();
		const restore = () => {
			if (draft && !this.getText()) this.setText(draft);
		};
		try {
			Promise.resolve(this.onSubmit?.(cmd)).finally(restore);
		} catch {
			restore();
		}
	}

	private openCmdline(initial: string): void {
		this.cmd = initial;
		this.cmdHistIdx = -1;
		this.tabBase = undefined;
		this.setMode("cmdline");
		this.updateCompletions();
	}

	private updateCompletions(): void {
		const word = this.cmd.split(/\s/)[0] ?? "";
		const matches = this.cmd.includes(" ") ? [] : completeCommand(word);
		this.ui?.setWidget(
			"vimpi",
			matches.length && word ? [matches.slice(0, 12).join("  ")].map((l) => this.piTheme?.fg("dim", l) ?? l) : undefined,
		);
	}

	private cmdlineKey(tok: string | undefined): void {
		if (tok === undefined) return;
		if (tok !== "<Tab>") this.tabBase = undefined;
		switch (tok) {
			case "<Esc>":
			case "<C-c>":
				this.setMode("normal");
				return;
			case "<CR>": {
				const line = this.cmd;
				this.setMode("normal");
				if (line.trim()) {
					this.cmdHist = [line, ...this.cmdHist.filter((h) => h !== line)].slice(0, 50);
					this.ex(line);
				}
				return;
			}
			case "<BS>":
				if (!this.cmd) {
					this.setMode("normal");
					return;
				}
				this.cmd = this.cmd.slice(0, prevChar(this.cmd, this.cmd.length));
				break;
			case "<C-u>":
				this.cmd = "";
				break;
			case "<C-w>":
				this.cmd = this.cmd.replace(/\S*\s*$/, "");
				break;
			case "<Up>":
			case "<Down>": {
				const idx = Math.max(-1, Math.min(this.cmdHist.length - 1, this.cmdHistIdx + (tok === "<Up>" ? 1 : -1)));
				this.cmdHistIdx = idx;
				this.cmd = idx < 0 ? "" : this.cmdHist[idx]!;
				break;
			}
			case "<Tab>": {
				if (this.cmd.includes(" ")) return;
				this.tabBase ??= this.cmd;
				const m = completeCommand(this.tabBase);
				if (!m.length) return;
				this.cmd = m[this.tabIdx++ % m.length]!;
				this.tui.requestRender();
				return;
			}
			default:
				if (tok.startsWith("<")) return;
				this.cmd += tok;
		}
		this.tabIdx = 0;
		this.updateCompletions();
		this.tui.requestRender();
	}

	ex(line: string): void {
		const raw = line.trim();
		if (raw.startsWith("!")) {
			this.slash(raw);
			return;
		}
		if (/^\d+$/.test(raw)) {
			const t = this.getText();
			this.moveTo(firstNonBlank(t, offsetOfLine(t, Math.min(lineCount(t) - 1, Math.max(0, Number(raw) - 1)))));
			return;
		}
		const [, name = "", arg = ""] = raw.match(/^(\S+)\s*(.*)$/) ?? [];
		const alias = EX_ALIASES[name.replace(/!$/, "")];
		const run = (c: string) => this.slash(arg ? `${c} ${arg}` : c);
		const density = name === "set" && arg.match(/^(no)?(dense|compact)(!?)$/);
		if (density) {
			const [, no, opt, bang] = density;
			const dense = bang ? state.density !== "dense" : (opt === "dense") !== !!no;
			this.setDensity(dense ? "dense" : "compact");
			return;
		}
		if (alias === "write") {
			if (this.getText().trim()) this.submit();
			return;
		}
		if (alias === "help") return showHelp();
		if (alias === "edit") {
			this.actionHandlers.get("app.editor.external")?.();
			return;
		}
		if (alias) return run(alias);
		if (completeCommand(name).includes(name)) return run(`/${name}`);
		this.say(`E492: Not an editor command: ${name}`, true);
	}

	// -----------------------------------------------------------------------
	// Rendering, dense: a single tinted input bar. The mode is a glyph on the
	// left; the status sits right-aligned on the last prompt line and recedes
	// segment by segment as the text grows into it.

	private hidden = { above: 0, below: 0 };

	setDensity(density: typeof state.density): void {
		state.density = density;
		if (density === "compact") removeDense(this.tui);
		this.say(density);
	}

	private modeGlyph(theme: Theme): string {
		if (this.leader) return theme.fg("warning", theme.bold("L"));
		return this.mode === "insert" ? theme.fg("success", theme.bold("I")) : theme.fg("accent", theme.bold("N"));
	}

	private denseStatus(theme: Theme, room: number): string {
		const segs: (Seg & { order: number })[] = [];
		const add = (text: string | undefined, pri: number, order: number) => {
			if (text) segs.push({ text, pri, order });
		};
		if (this.flash) add(theme.fg(this.flash.error ? "error" : "muted", this.flash.text), 9, 0);
		if (this.keys.length) add(theme.fg("warning", this.keys.join("")), 9, 1);
		const busy = this.raw.workingStatusIndicator;
		if (busy) add(busy.renderInBorder?.(24), 10, 2);
		const statuses = state.footer?.getExtensionStatuses();
		if (statuses) for (const v of statuses.values()) add(v, 1, 3);
		const branch = state.footer?.getGitBranch();
		if (branch) add(theme.fg("dim", `(${branch})`), 2, 4);
		const s = state.stats;
		if (s.cost > 0) add(theme.fg("dim", `$${s.cost.toFixed(2)}`), 3, 5);
		const think = thinkingTag(theme, state.pi?.getThinkingLevel());
		add(theme.fg("dim", shortModel(state.ctx?.model?.id)) + (think ? ` ${think}` : ""), 6, 6);
		const pct = s.percent;
		if (s.window && pct !== null) {
			add(theme.fg(pct >= 90 ? "error" : pct >= 70 ? "warning" : "dim", `${Math.round(pct)}%`), 7, 7);
		}
		const { above, below } = this.hidden;
		if (above || below) add(theme.fg("muted", `${above ? `↑${above}` : ""}${below ? `↓${below}` : ""}`), 8, 8);
		const width = () => segs.reduce((n, x) => n + visibleWidth(x.text) + 1, -1);
		while (segs.length && width() > room) {
			let drop = 0;
			for (let i = 1; i < segs.length; i++) if (segs[i]!.pri < segs[drop]!.pri) drop = i;
			segs.splice(drop, 1);
		}
		return segs
			.sort((a, b) => a.order - b.order)
			.map((x) => x.text)
			.join(" ");
	}

	render(width: number): string[] {
		hideResourceListing(this.tui);
		const theme = this.piTheme;
		if (state.density !== "dense" || !theme || width < 8) {
			removeDense(this.tui);
			return super.render(width);
		}
		applyDense(this.tui);
		const bar = (s: string) => tint(s, width, barBackground(theme));
		if (this.mode === "cmdline") return [bar(`${theme.fg("warning", ":")}${this.cmd}\x1b[7m \x1b[27m`)];
		const lines = super.render(width - 2);
		const n = Math.max(1, this.raw.renderedVisibleLineCount ?? lines.length - 2);
		const body = lines.slice(1, 1 + n).map((l, i) => (i === 0 ? `${this.modeGlyph(theme)} ` : "  ") + l.replace(/ +$/, ""));
		const last = body.length - 1;
		const used = visibleWidth(body[last]!);
		const status = this.denseStatus(theme, width - used - 3);
		if (status) body[last] += " ".repeat(Math.max(1, width - used - visibleWidth(status) - 1)) + status;
		return [...body.map(bar), ...lines.slice(2 + n)];
	}

	// Rendering, compact: borders are the status line

	protected renderTopBorder(width: number, hiddenLineCount: number): string {
		if (state.density === "dense") {
			this.hidden.above = hiddenLineCount;
			return "";
		}
		const theme = this.piTheme;
		if (this.raw.workingStatusIndicator || !theme || !state.ctx) return super.renderTopBorder(width, hiddenLineCount);
		const line = this.borderColor;
		const s = state.stats;
		const left: Seg[] = [{ text: theme.fg("text", shortModel(state.ctx.model?.id)), pri: 6 }];
		const think = thinkingTag(theme, state.pi?.getThinkingLevel());
		if (think) left.push({ text: think, pri: 4 });
		const right: Seg[] = [];
		if (hiddenLineCount > 0) right.push({ text: theme.fg("muted", `↑${hiddenLineCount}`), pri: 8 });
		if (s.cost > 0) right.push({ text: theme.fg("muted", `$${s.cost.toFixed(2)}`), pri: 3 });
		if (s.window) {
			const pct = s.percent;
			const color = pct === null ? "muted" : pct >= 90 ? "error" : pct >= 70 ? "warning" : "muted";
			right.push({ text: theme.fg(color, `${pct === null ? "?" : Math.round(pct)}%/${fmtTokens(s.window)}`), pri: 7 });
		}
		return borderRow(width, left, right, line);
	}

	protected renderBottomBorder(width: number, hiddenLineCount: number): string {
		if (state.density === "dense") {
			this.hidden.below = hiddenLineCount;
			return "";
		}
		const theme = this.piTheme;
		if (!theme) return super.renderBottomBorder(width, hiddenLineCount);
		if (this.mode === "cmdline") {
			const body = `:${this.cmd}`;
			const pad = Math.max(0, width - visibleWidth(body) - 1);
			return `${theme.fg("text", body)}\x1b[7m \x1b[27m${" ".repeat(pad)}`;
		}
		const line = this.borderColor;
		const badge =
			this.mode === "insert"
				? theme.inverse(theme.fg("success", theme.bold(" INSERT ")))
				: theme.inverse(theme.fg("accent", theme.bold(this.leader ? " LEADER " : " NORMAL ")));
		const left: Seg[] = [{ text: badge, pri: 10 }];
		if (this.keys.length) left.push({ text: theme.fg("warning", this.keys.join("")), pri: 9 });
		if (this.flash) left.push({ text: theme.fg(this.flash.error ? "error" : "muted", this.flash.text), pri: 8 });
		const right: Seg[] = [];
		const statuses = state.footer?.getExtensionStatuses();
		if (statuses) for (const v of statuses.values()) if (v) right.push({ text: v, pri: 1 });
		const branch = state.footer?.getGitBranch();
		if (branch) right.push({ text: theme.fg("muted", `(${branch})`), pri: 2 });
		if (hiddenLineCount > 0) right.push({ text: theme.fg("muted", `↓${hiddenLineCount}`), pri: 8 });
		return borderRow(width, left, right, line, false);
	}
}

/** Paint a full-width background behind a styled line, surviving inner SGR resets. */
function tint(line: string, width: number, bg: string): string {
	const body = line.replace(/\x1b\[0?m|\x1b\[49m/g, (m) => m + bg);
	return `${bg}${body}${" ".repeat(Math.max(0, width - visibleWidth(line)))}\x1b[0m`;
}

/** First background the theme really defines; system themes may leave some as the terminal default. */
function barBackground(theme: Theme): string {
	for (const token of ["userMessageBg", "toolPendingBg", "selectedBg"] as const) {
		const ansi = theme.getBgAnsi(token);
		if (ansi && ansi !== "\x1b[49m") return ansi;
	}
	return "";
}
