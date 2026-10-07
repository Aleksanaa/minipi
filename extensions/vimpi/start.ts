/**
 * Start screen: shown in place of pi's header while the session has no
 * messages, gone with the first one. Sections are ranked; on short
 * terminals the least useful are dropped so everything fits above the bar.
 *
 *   pi 1.0.3 · vimpi                         ~/works/pi (master) *3
 *
 *   model    opus-5-5 · anthropic · hi · 200k
 *   tools    read bash edit write
 *   context  AGENTS.md · 3 skills · 2 prompts
 *
 *   recent                                        :recent N opens
 *   1 fix the flake check                           2h · 14 msgs
 *
 *   type, Enter · Esc normal · SPC leader · : command · :h help
 *   tip  ci" rewrites a quoted string; . repeats it
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type SessionInfo,
	SessionManager,
	type Theme,
	VERSION,
} from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { KEEP } from "./dense.ts";
import { fmtTokens, shortModel, state } from "./status.ts";

// Each fits the 66-column screen after the "tip" label.
const TIPS = [
	'ci" rewrites a quoted string; . repeats it',
	"SPC m picks a model, SPC t cycles thinking",
	"SPC o expands tool output; SPC y copies the last reply",
	"j/k at the prompt edge scroll the transcript",
	"[[ and ]] jump between your prompts",
	"gg / G on a one-line prompt: transcript top / bottom",
	":!cmd runs a shell command into the transcript",
	"Esc twice stops a running agent",
	"SPC d toggles dense / compact; /vim turns vimpi off",
	"daw deletes a word and its space",
	":m sonnet picks a model by fuzzy name",
	"u undoes a whole insert; ctrl+r redoes it",
	":recent 2 reopens your second-latest session here",
];

const CONTEXT_FILES = ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md"];

interface StartData {
	recent: SessionInfo[];
	dirty?: number;
	contextFiles: string[];
	tip: string;
}

export const start: StartData = { recent: [], contextFiles: [], tip: TIPS[0]! };

function tildify(p: string): string {
	const home = homedir();
	return p === home ? "~" : p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

function age(d: Date): string {
	const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
	if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
	if (s < 86400) return `${Math.round(s / 3600)}h`;
	if (s < 86400 * 30) return `${Math.round(s / 86400)}d`;
	return `${Math.round(s / (86400 * 30))}mo`;
}

/** Context files pi will load: agent dir, then cwd and every parent. */
function findContextFiles(cwd: string): string[] {
	const found: string[] = [];
	const look = (dir: string, label: (f: string) => string) => {
		for (const f of CONTEXT_FILES) {
			if (existsSync(join(dir, f))) {
				found.push(label(f));
				break; // pi loads one per directory
			}
		}
	};
	look(getAgentDir(), (f) => `~agent/${f}`);
	for (let dir = cwd; ; dir = dirname(dir)) {
		look(dir, (f) => relative(cwd, join(dir, f)) || f);
		if (dirname(dir) === dir) break;
	}
	return found;
}

/** Gather the slower facts in the background; the screen fills in as they arrive. */
export function refreshStart(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const cwd = ctx.cwd;
	start.tip = TIPS[Math.floor(Math.random() * TIPS.length)]!;
	start.contextFiles = findContextFiles(cwd);
	start.dirty = undefined;
	const current = ctx.sessionManager.getSessionFile();
	SessionManager.list(cwd, ctx.sessionManager.getSessionDir())
		.then((list) => {
			start.recent = list
				.filter((s) => s.path !== current && s.messageCount > 0)
				.sort((a, b) => b.modified.getTime() - a.modified.getTime())
				.slice(0, 9);
			state.requestRender();
		})
		.catch(() => {});
	pi.exec("git", ["status", "--porcelain"], { cwd, timeout: 2000 })
		.then((r) => {
			if (r.code === 0) start.dirty = r.stdout.split("\n").filter(Boolean).length;
			state.requestRender();
		})
		.catch(() => {});
}

export function hasMessages(ctx: ExtensionContext | undefined): boolean {
	try {
		return !!ctx?.sessionManager.getBranch().some((e) => e.type === "message");
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------

interface Section {
	lines: string[];
	/** Higher survives longer on short terminals. */
	pri: number;
}

function row(theme: Theme, label: string, value: string, width: number): string {
	return truncateToWidth(`${theme.fg("muted", label.padEnd(9))}${value}`, width, "…");
}

function spread(left: string, right: string, width: number): string {
	const gap = width - visibleWidth(left) - visibleWidth(right);
	return gap >= 2 ? left + " ".repeat(gap) + right : truncateToWidth(left, width, "…");
}

function sections(theme: Theme, width: number, recentRows: number): Section[] {
	const ctx = state.ctx;
	const pi = state.pi;
	const out: Section[] = [];
	const dim = (s: string) => theme.fg("dim", s);

	// Title: what and where
	const branch = state.footer?.getGitBranch();
	const where =
		theme.fg("muted", tildify(ctx?.cwd ?? process.cwd())) +
		(branch ? theme.fg("dim", ` (${branch})`) : "") +
		(start.dirty ? theme.fg("warning", ` *${start.dirty}`) : "");
	const title = `${theme.fg("accent", theme.bold(`pi ${VERSION}`))}${dim(" · vimpi")}`;
	out.push({ lines: [spread(title, where, width)], pri: 10 });

	// Setup: model, tools, context
	const model = ctx?.model;
	const setup: string[] = [];
	if (model) {
		const parts = [theme.fg("text", shortModel(model.id)), dim(model.provider)];
		const think = pi?.getThinkingLevel();
		if (think && think !== "off") parts.push(theme.fg("accent", think));
		if (model.contextWindow) parts.push(dim(`${fmtTokens(model.contextWindow)} ctx`));
		setup.push(row(theme, "model", parts.join(dim(" · ")), width));
	} else {
		setup.push(row(theme, "model", theme.fg("error", "none - :login, or set an API key"), width));
	}
	const tools = pi?.getActiveTools() ?? [];
	if (tools.length) setup.push(row(theme, "tools", tools.join(" "), width));
	const cmds = (() => {
		try {
			return pi?.getCommands() ?? [];
		} catch {
			return [];
		}
	})();
	const count = (src: string) => cmds.filter((c) => c.source === src).length;
	const ctxParts = [...start.contextFiles];
	for (const [n, label] of [
		[count("skill"), "skills"],
		[count("prompt"), "prompts"],
		[count("extension"), "commands"],
	] as const) {
		if (n) ctxParts.push(`${n} ${label}`);
	}
	if (ctxParts.length) setup.push(row(theme, "context", ctxParts.join(dim(" · ")), width));
	out.push({ lines: setup, pri: 8 });

	// Recent sessions in this directory
	const recent = start.recent.slice(0, recentRows);
	if (recent.length) {
		const lines = [spread(theme.fg("muted", "recent"), dim(":recent N opens"), width)];
		recent.forEach((s, i) => {
			const label = (s.name || s.firstMessage || "(untitled)").replace(/\s+/g, " ").trim();
			const meta = dim(`${age(s.modified)} · ${s.messageCount} msgs`);
			const room = width - visibleWidth(meta) - 4;
			lines.push(spread(`${theme.fg("accent", String(i + 1))} ${truncateToWidth(label, Math.max(8, room), "…")}`, meta, width));
		});
		out.push({ lines, pri: 6 });
	}

	// How to drive it
	const keys = [
		`type, ${theme.fg("success", "Enter")}`,
		`${theme.fg("warning", "Esc")} normal`,
		`${theme.fg("warning", "SPC")} leader`,
		`${theme.fg("warning", ":")} command`,
		`${theme.fg("warning", ":h")} help`,
	].join(dim(" · "));
	out.push({ lines: [truncateToWidth(keys, width, "…")], pri: 9 });
	out.push({ lines: [truncateToWidth(`${theme.fg("muted", "tip")}  ${dim(start.tip)}`, width, "…")], pri: 4 });
	return out;
}

/** Component used as pi's header. Renders nothing once the conversation starts. */
export function startScreen(tui: TUI, theme: Theme): Component {
	return {
		invalidate() {},
		render(width: number): string[] {
			if (!state.enabled || hasMessages(state.ctx)) return [];
			const w = Math.max(10, width - 2);
			const avail = Math.max(3, tui.terminal.rows - 2);
			let recentRows = 5;
			let secs = sections(theme, w, recentRows);
			const height = (xs: Section[]) => xs.reduce((n, s) => n + s.lines.length, 0) + Math.max(0, xs.length - 1);
			// Shrink: fewer recent sessions first, then drop sections by priority.
			while (height(secs) > avail && recentRows > 1) secs = sections(theme, w, --recentRows);
			while (height(secs) > avail && secs.length > 1) {
				const min = secs.reduce((m, s) => (s.pri < m.pri ? s : m));
				secs = secs.filter((s) => s !== min);
			}
			const body: string[] = [];
			secs.forEach((s, i) => {
				if (i) body.push("");
				body.push(...s.lines);
			});
			// Sit in the upper third of the free space. KEEP stops the dense filter from eating the padding.
			const top = Math.max(0, Math.floor((avail - body.length) / 3));
			return [...Array(top).fill(KEEP), ...body.map((l) => KEEP + (l ? ` ${l}` : ""))];
		},
	};
}

/** `/recent [n]`: open the n-th most recent session here, or list them. */
export function registerRecentCommand(pi: ExtensionAPI): void {
	pi.registerCommand("recent", {
		description: "Open a recent session of this directory by number (no number: picker)",
		handler: async (args, ctx) => {
			const n = Number.parseInt(args.trim(), 10);
			const s = start.recent[n - 1];
			if (!n) {
				await ctx.waitForIdle();
				const choice = await ctx.ui.select(
					"Recent sessions",
					start.recent.map((r, i) => `${i + 1} ${(r.name || r.firstMessage).replace(/\s+/g, " ").slice(0, 50)}`),
				);
				const idx = choice ? Number.parseInt(choice, 10) - 1 : -1;
				if (start.recent[idx]) await ctx.switchSession(start.recent[idx]!.path);
				return;
			}
			if (!s) {
				ctx.ui.notify(`No recent session ${n}`, "warning");
				return;
			}
			await ctx.switchSession(s.path);
		},
	});
}
