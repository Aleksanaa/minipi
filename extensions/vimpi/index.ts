/**
 * vimpi - a compact, modal (vim-style) UI for pi, tuned for 66x20 terminals.
 *
 * Glyphs are ASCII plus a few characters present in both Terminus and Hack
 * (─ … · ↑ ↓), so bitmap and plain monospace fonts render everything.
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
 *
 * `/vim` toggles the whole UI off and on.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerCheckpoints } from "./checkpoint.ts";
import { removeDense, showResourceListing } from "./dense.ts";
import { VimEditor } from "./editor.ts";
import { registerGuard } from "./guard.ts";
import { registerMagic } from "./magic.ts";
import { registerRecentCommand, refreshStart, startScreen } from "./start.ts";
import { refreshStats, state } from "./status.ts";
import { installTodoWidget, registerTodo, uninstallTodoWidget } from "./todo.ts";
import { registerCompactTools } from "./tools.ts";

const empty = () => ({ render: (): string[] => [], invalidate() {} });

function install(ctx: ExtensionContext): void {
	if (ctx.mode !== "tui") return;
	ctx.ui.setEditorComponent((tui, theme, keybindings) => {
		state.tui = tui;
		state.requestRender = () => tui.requestRender();
		return new VimEditor(tui, theme, keybindings);
	});
	ctx.ui.setHeader(startScreen);
	ctx.ui.setFooter((tui, _theme, footer) => {
		state.footer = footer;
		const unsubscribe = footer.onBranchChange(() => tui.requestRender());
		return { ...empty(), dispose: unsubscribe };
	});
	ctx.ui.setHiddenThinkingLabel("· thinking");
	// pi's default spinner is braille, which Hack lacks.
	ctx.ui.setWorkingIndicator({ frames: ["-", "\\", "|", "/"], intervalMs: 120 });
	installTodoWidget(ctx);
	refreshStats(ctx);
}

function uninstall(ctx: ExtensionContext): void {
	if (state.tui) {
		removeDense(state.tui);
		showResourceListing(state.tui);
	}
	ctx.ui.setEditorComponent(undefined);
	ctx.ui.setHeader(undefined);
	ctx.ui.setFooter(undefined);
	ctx.ui.setWidget("vimpi", undefined);
	uninstallTodoWidget(ctx);
	ctx.ui.setHiddenThinkingLabel();
	ctx.ui.setWorkingIndicator();
	state.footer = undefined;
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
		if (state.enabled) install(ctx);
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

	pi.registerCommand("vim", {
		description: "Toggle the vimpi compact modal UI",
		handler: async (_args, ctx) => {
			state.enabled = !state.enabled;
			state.ctx = ctx;
			if (state.enabled) install(ctx);
			else uninstall(ctx);
			ctx.ui.notify(`vimpi ${state.enabled ? "on" : "off"}`, "info");
		},
	});
}
