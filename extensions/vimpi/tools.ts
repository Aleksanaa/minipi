/**
 * One-line tool rows for every tool (built-in, extension, MCP), drawn via
 * pi.registerToolRenderer so no tool is replaced or re-registered.
 *
 *   * read  src/app.ts:10-60                              51L
 *   ! $ npm test                                        exit 1
 *     FAIL src/app.test.ts
 *
 * Status: * done, ! failed, ~ running. ASCII only, for bitmap fonts.
 *
 * Expanded view (ctrl+o / <space>o) shows a bounded body below the line.
 */

import type { ExtensionAPI, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { relative } from "node:path";
import { TOOL } from "./dense.ts";
import { truncMid } from "./status.ts";

// biome-ignore lint/suspicious/noExplicitAny: renderers are shared by all tools
type AnyDef = ToolDefinition<any, any, any>;
type RenderContext = Parameters<NonNullable<AnyDef["renderCall"]>>[2];

const EXPANDED_LINES = 30;
const TITLE_WIDTH = 5;

interface Row {
	done?: boolean;
	isError?: boolean;
	text?: string;
	// biome-ignore lint/suspicious/noExplicitAny: tool-specific details
	details?: any;
	image?: boolean;
}

// biome-ignore lint/suspicious/noExplicitAny: tool-specific args
type Args = Record<string, any> | undefined;

class Lines implements Component {
	constructor(private readonly fn: (width: number) => string[]) {}
	render(width: number): string[] {
		// Leave the last column free: the fullscreen scrollbar is drawn over it.
		const w = Math.max(1, width - 1);
		return this.fn(w).map((l) => (visibleWidth(l) > w ? truncateToWidth(l, w, "…") : l));
	}
	invalidate(): void {}
}

function displayPath(p: unknown, cwd: string): string {
	if (typeof p !== "string" || !p) return "…";
	if (p.startsWith("/")) {
		const rel = relative(cwd, p);
		if (!rel.startsWith("..")) return rel || ".";
		if (p.startsWith(homedir())) return `~${p.slice(homedir().length)}`;
	}
	return p;
}

function countLines(s: string | undefined): number {
	const t = s?.replace(/\s+$/, "");
	return t ? t.split("\n").length : 0;
}

function diffStat(details: { diff?: string } | undefined): string {
	if (!details?.diff) return "";
	let add = 0;
	let del = 0;
	for (const l of details.diff.split("\n")) {
		if (l.startsWith("+")) add++;
		else if (l.startsWith("-")) del++;
	}
	return `+${add} -${del}`;
}

/** The most telling argument of an unknown tool: a path, pattern or query. */
function primaryArg(args: Args): string | undefined {
	if (!args) return undefined;
	for (const key of ["path", "file", "pattern", "query", "command", "url", "name"]) {
		if (typeof args[key] === "string") return args[key];
	}
	const first = Object.values(args).find((v) => typeof v === "string");
	return typeof first === "string" ? first.split("\n")[0] : undefined;
}

function subject(name: string, args: Args, cwd: string, theme: Theme, room: number): string {
	room = Math.max(4, room);
	if (name === "bash") return theme.fg("text", truncateToWidth(String(args?.command ?? "…").split("\n")[0]!, room, "…"));
	if (name === "read") {
		let range = "";
		if (args?.offset !== undefined || args?.limit !== undefined) {
			const a = args?.offset ?? 1;
			range = `:${a}${args?.limit !== undefined ? `-${a + args.limit - 1}` : ""}`;
		}
		return theme.fg("accent", truncMid(displayPath(args?.path, cwd), room - range.length)) + theme.fg("muted", range);
	}
	if (name === "grep" || name === "find") {
		const where = args?.path ? ` ${displayPath(args.path, cwd)}` : "";
		return theme.fg("accent", truncMid(`${args?.pattern ?? "…"}`, room - where.length)) + theme.fg("muted", where);
	}
	if (name === "todo") {
		const what = Array.isArray(args?.items) ? args.items.join(", ") : Array.isArray(args?.ids) ? args.ids.join(" ") : "";
		return theme.fg("muted", truncateToWidth(`${args?.action ?? "…"} ${what}`.trim(), room, "…"));
	}
	if (args?.path !== undefined) return theme.fg("accent", truncMid(displayPath(args.path, cwd), room));
	const arg = primaryArg(args);
	return arg ? theme.fg("muted", truncateToWidth(arg, room, "…")) : "";
}

function summary(name: string, args: Args, row: Row): string {
	if (!row.done) return "";
	if (row.isError) {
		const m = row.text?.match(/exited with code (\d+)/);
		return m ? `exit ${m[1]}` : "error";
	}
	if (row.image) return "img";
	switch (name) {
		case "read":
			return `${countLines(row.text)}L${row.details?.truncation?.truncated ? "+" : ""}`;
		case "write":
			return `${countLines(args?.content)}L`;
		case "edit":
			return diffStat(row.details);
		case "bash":
			return countLines(row.text) ? `${countLines(row.text)}L` : "ok";
		case "grep":
		case "find":
		case "ls":
			return `${countLines(row.text)}`;
		case "todo": {
			const todos = row.details?.todos;
			return Array.isArray(todos) ? `${todos.filter((t: { done: boolean }) => t.done).length}/${todos.length}` : "";
		}
	}
	const n = countLines(row.text);
	return n ? `${n}L` : "";
}

function callLine(name: string, args: Args, rc: RenderContext, theme: Theme, width: number): string {
	const row = rc.state as Row;
	const glyph = TOOL + (!row.done ? theme.fg("warning", "~") : row.isError ? theme.fg("error", "!") : theme.fg("success", "*"));
	const label = name === "bash" ? "$" : name.length <= TITLE_WIDTH ? name.padEnd(TITLE_WIDTH) : name;
	const title = theme.fg("toolTitle", theme.bold(label));
	const right = summary(name, args, row);
	const rightW = right ? visibleWidth(right) + 1 : 0;
	const left = `${glyph} ${title} ${subject(name, args, rc.cwd, theme, width - 3 - visibleWidth(title) - rightW)}`;
	if (!right) return left;
	const pad = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
	return left + " ".repeat(pad) + theme.fg(row.isError ? "error" : "muted", right);
}

function bodyLines(name: string, args: Args, row: Row, expanded: boolean, theme: Theme): string[] {
	const text = (row.text ?? "").replace(/\s+$/, "");
	const indent = "  ";
	if (!expanded) {
		if (row.isError && text) {
			// For bash the useful part is right before the exit status.
			// The exit status is already in the summary on the call line.
			const ls = text.split("\n").filter((l) => l.trim() && !/^Command exited with code \d+$/.test(l));
			return (name === "bash" ? ls.slice(-3) : ls.slice(0, 2)).map((l) => indent + theme.fg("error", l));
		}
		if (!row.done && text) {
			const last = text.split("\n").filter((l) => l.trim()).pop();
			return last ? [indent + theme.fg("dim", last)] : [];
		}
		return [];
	}
	let ls: string[];
	if (name === "edit" && row.details?.diff && !row.isError) {
		ls = String(row.details.diff)
			.split("\n")
			.map((l) => theme.fg(l.startsWith("+") ? "toolDiffAdded" : l.startsWith("-") ? "toolDiffRemoved" : "toolDiffContext", l));
	} else if (name === "write" && !row.isError) {
		ls = String(args?.content ?? "")
			.split("\n")
			.map((l) => theme.fg("toolOutput", l));
	} else {
		ls = text ? text.split("\n").map((l) => theme.fg(row.isError ? "error" : "toolOutput", l)) : [];
	}
	if (ls.length > EXPANDED_LINES) {
		const more = theme.fg("muted", `… ${ls.length - EXPANDED_LINES} more lines`);
		ls = name === "bash" ? [more, ...ls.slice(-EXPANDED_LINES)] : [...ls.slice(0, EXPANDED_LINES), more];
	}
	return ls.map((l) => indent + l);
}

export function registerCompactTools(pi: ExtensionAPI): void {
	pi.registerToolRenderer((name) => ({
		renderShell: "self",
		renderCall(args, theme, rc) {
			return new Lines((w) => [callLine(name, args as Args, rc, theme, w)]);
		},
		renderResult(result, opts, theme, rc) {
			const row = rc.state as Row;
			const text = result.content.find((c) => c.type === "text");
			row.done = !opts.isPartial;
			row.isError = rc.isError;
			row.text = text?.type === "text" ? text.text : undefined;
			row.details = result.details;
			row.image = result.content.some((c) => c.type === "image");
			return new Lines(() => bodyLines(name, rc.args as Args, row, opts.expanded, theme));
		},
	}));
}
