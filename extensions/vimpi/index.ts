/**
 * vimpi - a compact, modal (vim-style) UI for pi, tuned for 66x20 terminals.
 *
 * Glyphs are ASCII plus a few characters present in both Terminus and Hack
 * (─ … · ↑ ↓), so bitmap and plain monospace fonts render everything.
 * Colors: all output is rewritten to the 3-bit SGR codes 30-37/40-47
 * (ansi8.ts); themes/basic8.json picks colors that survive that.
 *
 * - pi's header becomes a start screen (model, context, recent sessions)
 *   that disappears with the first message; the footer takes zero rows.
 * - Built-in tools render as one line each (ctrl+o / <space>o to expand).
 * - The prompt editor has insert/normal/command-line modes with real vim
 *   motions, operators and text objects; normal mode also drives the
 *   fullscreen transcript (scroll, search, jump between prompts).
 * - A `todo` tool with a one-row progress line, and magic prompt keywords
 *   (ultrathink, stepwise, tldr).
 * - Git checkpoints per prompt, offered back on /fork; writes to .env,
 *   .git/ and node_modules/ are blocked.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { install8Colors } from "./ansi8.ts";
import { registerCheckpoints } from "./checkpoint.ts";
import { VimEditor } from "./editor.ts";
import { registerGuard } from "./guard.ts";
import { registerMagic } from "./magic.ts";
import { registerRecentCommand, refreshStart, startScreen } from "./start.ts";
import { refreshStats, state } from "./status.ts";
import { registerTodo, todoWidget } from "./todo.ts";
import { registerCompactTools } from "./tools.ts";

function install(ctx: ExtensionContext): void {
	if (ctx.mode !== "tui") return;
	ctx.ui.setEditorComponent((tui, theme, keybindings) => {
		state.requestRender = () => tui.requestRender();
		install8Colors(tui.terminal);
		tui.requestRender(true); // repaint rows already drawn with 256-color codes
		return new VimEditor(tui, theme, keybindings);
	});
	ctx.ui.setHeader(startScreen);
	ctx.ui.setFooter((tui, _theme, footer) => {
		state.footer = footer;
		return { render: () => [], invalidate() {}, dispose: footer.onBranchChange(() => tui.requestRender()) };
	});
	ctx.ui.setHiddenThinkingLabel("· thinking");
	// pi's default spinner is braille, which Hack lacks.
	ctx.ui.setWorkingIndicator({ frames: ["-", "\\", "|", "/"], intervalMs: 120 });
	ctx.ui.setWidget("vimpi-todo", todoWidget);
	refreshStats(ctx);
}

export default function vimpi(pi: ExtensionAPI): void {
	state.pi = pi;
	registerCompactTools(pi);
	registerRecentCommand(pi);
	registerTodo(pi);
	registerMagic(pi);
	registerCheckpoints(pi);
	registerGuard(pi);

	pi.on("session_start", (_event, ctx) => {
		state.ctx = ctx;
		refreshStart(pi, ctx);
		install(ctx);
	});
	pi.on("session_shutdown", () => {
		state.ctx = undefined;
	});

	const refresh = (_event: unknown, ctx: ExtensionContext) => {
		state.ctx = ctx;
		refreshStats(ctx);
	};
	pi.on("turn_end", refresh);
	pi.on("agent_end", refresh);
	pi.on("model_select", refresh);
	pi.on("thinking_level_select", refresh);
	pi.on("session_compact", refresh);
	pi.on("session_tree", refresh);
}
