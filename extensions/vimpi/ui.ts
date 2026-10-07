/**
 * Leader map, which-key popup, ex-command table/completion and the help
 * overlay.
 */

import type { AppKeybinding, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { state } from "./status.ts";

export interface LeaderEntry {
	key: string;
	label: string;
	action?: AppKeybinding;
	slash?: string;
	run?: "help" | "pasteImage" | "density" | "todos";
}

export const LEADER: LeaderEntry[] = [
	{ key: "m", label: "model…", action: "app.model.select" },
	{ key: "M", label: "next model", action: "app.model.cycleForward" },
	{ key: "t", label: "thinking +", action: "app.thinking.cycle" },
	{ key: "T", label: "show think", action: "app.thinking.toggle" },
	{ key: "o", label: "tool output", action: "app.tools.expand" },
	{ key: "l", label: "todo list", run: "todos" },
	{ key: "e", label: "$EDITOR", action: "app.editor.external" },
	{ key: "y", label: "copy reply", action: "app.message.copy" },
	{ key: "v", label: "paste img", run: "pasteImage" },
	{ key: "n", label: "new session", slash: "/new" },
	{ key: "r", label: "resume", slash: "/resume" },
	{ key: "f", label: "fork", slash: "/fork" },
	{ key: "h", label: "tree", slash: "/tree" },
	{ key: "c", label: "compact", slash: "/compact" },
	{ key: "s", label: "settings", slash: "/settings" },
	{ key: "q", label: "quit", slash: "/quit" },
	{ key: "d", label: "density", run: "density" },
	{ key: "?", label: "help", run: "help" },
];

/** Ex names to pi slash commands, or to a special action handled by the editor. */
export const EX_ALIASES: Record<string, string> = {
	q: "/quit",
	qa: "/quit",
	quit: "/quit",
	w: "write",
	write: "write",
	h: "help",
	help: "help",
	e: "edit",
	edit: "edit",
	m: "/model",
	th: "/thinking",
	n: "/new",
	enew: "/new",
	r: "/resume",
	c: "/compact",
	set: "/settings",
	t: "/tree",
};

const BUILTIN = [
	"settings",
	"model",
	"tree",
	"thinking",
	"scoped-models",
	"export",
	"import",
	"share",
	"copy",
	"name",
	"session",
	"changelog",
	"hotkeys",
	"fork",
	"clone",
	"trust",
	"login",
	"logout",
	"new",
	"compact",
	"resume",
	"reload",
	"quit",
];

export function completeCommand(prefix: string): string[] {
	let ext: string[] = [];
	try {
		ext = state.pi?.getCommands().map((c) => c.name) ?? [];
	} catch {
		// Not available before the session is bound.
	}
	const names = new Set([...BUILTIN, ...ext, "help", "write", "edit"]);
	return [...names].filter((n) => n.startsWith(prefix)).sort((a, b) => a.length - b.length || a.localeCompare(b));
}

/** Grid of `k label` cells sized to the available width. */
export function whichKeyWidget(entries: LeaderEntry[]) {
	return (_tui: TUI, theme: Theme): Component => ({
		invalidate() {},
		render(width: number): string[] {
			const cellW = Math.max(...entries.map((e) => visibleWidth(e.label))) + 3;
			const cols = Math.max(1, Math.floor((width + 1) / (cellW + 1)));
			const rows = Math.ceil(entries.length / cols);
			const out: string[] = [];
			for (let r = 0; r < rows; r++) {
				let line = "";
				for (let c = 0; c < cols; c++) {
					const e = entries[c * rows + r];
					if (!e) break;
					const cell = `${theme.fg("accent", theme.bold(e.key))} ${theme.fg("muted", e.label)}`;
					line += cell + " ".repeat(Math.max(1, cellW + 1 - visibleWidth(cell)));
				}
				out.push(truncateToWidth(line.trimEnd(), width, ""));
			}
			return out;
		},
	});
}

// ---------------------------------------------------------------------------
// Help overlay

function helpLines(theme: Theme): string[] {
	const h = (s: string) => theme.fg("accent", theme.bold(s));
	// 2 + 21 + longest description (39) still fits 66 columns.
	const k = (keys: string, desc: string) => `  ${theme.fg("warning", keys.padEnd(21))}${theme.fg("text", desc)}`;
	const leader = LEADER.map((e) => k(`SPC ${e.key}`, e.label));
	return [
		h("NORMAL  (Esc from insert)"),
		k("i a I A o O", "insert before/after/bol/eol/below/above"),
		k("h l w b e ge W B E", "move; counts work: 3w"),
		k("0 ^ $  f t F T ; ,", "line ends, find char, repeat"),
		k("%", "matching bracket"),
		k("d c y {motion}", "operators; dd cc yy linewise"),
		k("g~ gu gU {motion}", "toggle / lower / upper case"),
		k("iw aw iW i\" i' i( ib", "text objects: diw ci\" da("),
		k("i[ i{ iB i< ip", "more text objects"),
		k("x X D C s S Y", "shortcuts for dl dh d$ c$ cl cc yy"),
		k("p P J r ~", "put after/before, join, replace, case"),
		k("u  ^R  .", "undo, redo, repeat last change"),
		k("Enter", "send prompt"),
		"",
		h("TRANSCRIPT  (fullscreen)"),
		k("^E ^Y", "scroll one line"),
		k("^D ^U  ^F ^B", "half page / page"),
		k("j k at first/last", "spill over: scroll transcript"),
		k("gg G (1-line prompt)", "transcript top / bottom"),
		k("[[ ]]", "previous / next prompt"),
		k("/ ?", "search transcript"),
		"",
		h("LEADER  (space)"),
		...leader,
		"",
		h("COMMAND LINE  (:)"),
		k(":q  ZZ", "quit"),
		k(":w", "send prompt"),
		k(":m [name]", "model (selector or fuzzy)"),
		k(":th [level]", "thinking level"),
		k(":n :r :t :c", "new, resume, tree, compact"),
		k(":recent [N]", "reopen recent session N (start screen)"),
		k(":todos  SPC l", "expand / collapse the todo list"),
		k(":set :e :h", "settings, $EDITOR, this help"),
		k(":set dense!  SPC d", "toggle dense / compact layout"),
		k(":!cmd", "run shell command"),
		k(":12", "go to prompt line 12"),
		k(":<any /command>", "every pi slash command works"),
		k("Tab Up Down", "complete, history"),
		"",
		h("INSERT"),
		k("Esc", "normal mode; Esc again aborts the agent"),
		k("Esc Esc (NORMAL)", "empty prompt, idle: session tree"),
		"",
		h("MAGIC WORDS  (anywhere in a prompt)"),
		k("ultrathink", "max thinking for this run"),
		k("stepwise", "plan with todos, then work through"),
		k("tldr", "reply in a few short lines"),
		k("ctrl+o shift+tab", "all pi keys keep working"),
	];
}

class HelpView implements Component {
	private top = 0;
	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly done: () => void,
	) {}

	private height(): number {
		return Math.max(3, this.tui.terminal.rows - 1);
	}

	handleInput(data: string): void {
		const total = helpLines(this.theme).length;
		const page = this.height() - 1;
		const max = Math.max(0, total - page);
		if (matchesKey(data, "escape") || data === "q" || matchesKey(data, "enter")) return this.done();
		if (data === "j" || matchesKey(data, "down") || matchesKey(data, "ctrl+e")) this.top++;
		else if (data === "k" || matchesKey(data, "up") || matchesKey(data, "ctrl+y")) this.top--;
		else if (matchesKey(data, "ctrl+d") || data === " ") this.top += Math.floor(page / 2);
		else if (matchesKey(data, "ctrl+u")) this.top -= Math.floor(page / 2);
		else if (data === "g") this.top = 0;
		else if (data === "G") this.top = max;
		this.top = Math.max(0, Math.min(max, this.top));
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const lines = helpLines(this.theme);
		const page = this.height() - 1;
		const body = lines.slice(this.top, this.top + page).map((l) => truncateToWidth(l, width, "…", true));
		while (body.length < page) body.push(" ".repeat(width));
		const pos = `${Math.min(lines.length, this.top + page)}/${lines.length}`;
		const label = ` vimpi help · j/k ^D/^U · q close · ${pos} `;
		const bar = this.theme.fg("borderAccent", `─${label}${"─".repeat(Math.max(0, width - visibleWidth(label) - 1))}`);
		return [...body, truncateToWidth(bar, width, "")];
	}

	invalidate(): void {}
}

export function showHelp(): void {
	const ui = state.ctx?.ui;
	if (!ui) return;
	void ui.custom<void>((tui, theme, _kb, done) => new HelpView(tui, theme, () => done()), {
		overlay: true,
		overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
	});
}
