/**
 * `todo` tool for the model plus a one-row progress line above the prompt:
 *
 *   todo 2/5 > write the tests
 *
 * `/todos` or SPC l expands it to the full list. The row disappears when
 * nothing is open. The tool row itself is drawn by tools.ts.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { state } from "./status.ts";
import { applyTodo, emptyTodos, formatTodos, progress, type TodoDetails, type TodoList, type TodoParams } from "./todolist.ts";

const EXPANDED_MAX = 8;

let list: TodoList = emptyTodos();
let expanded = false;

const Params = Type.Object({
	action: Type.Union(
		["list", "add", "done", "undo", "remove", "clear"].map((a) => Type.Literal(a)),
		{ description: "add: append items. done/undo: mark ids (un)finished. remove: delete ids. clear: empty the list." },
	),
	items: Type.Optional(Type.Array(Type.String(), { description: "Todo texts, for add" })),
	ids: Type.Optional(Type.Array(Type.Number(), { description: "Todo ids, for done/undo/remove" })),
});

function rebuild(ctx: ExtensionContext): void {
	list = emptyTodos();
	try {
		for (const e of ctx.sessionManager.getBranch()) {
			if (e.type !== "message" || e.message.role !== "toolResult" || e.message.toolName !== "todo") continue;
			const d = e.message.details as TodoDetails | undefined;
			if (d?.todos) list = { todos: d.todos, nextId: d.nextId };
		}
	} catch {
		// Session mid-replacement; keep an empty list.
	}
	state.requestRender();
}

function widget(_tui: unknown, theme: Theme): Component {
	return {
		invalidate() {},
		render(width: number): string[] {
			if (!state.enabled) return [];
			const { done, total, next } = progress(list);
			if (expanded) {
				if (!total) return [theme.fg("dim", "no todos")];
				const rows = list.todos.slice(0, EXPANDED_MAX).map((t) => {
					const mark = t.done ? theme.fg("success", "[x]") : theme.fg("muted", "[ ]");
					return truncateToWidth(`${mark} ${theme.fg("accent", `${t.id}`)} ${theme.fg(t.done ? "dim" : "text", t.text)}`, width, "…");
				});
				if (total > EXPANDED_MAX) rows.push(theme.fg("dim", `… ${total - EXPANDED_MAX} more`));
				return rows;
			}
			if (!next) return [];
			const head = `${theme.fg("muted", "todo")} ${theme.fg("accent", `${done}/${total}`)} ${theme.fg("muted", ">")} `;
			return [truncateToWidth(head + theme.fg("text", next.text), width, "…")];
		},
	};
}

export function installTodoWidget(ctx: ExtensionContext): void {
	ctx.ui.setWidget("vimpi-todo", widget);
}

export function uninstallTodoWidget(ctx: ExtensionContext): void {
	ctx.ui.setWidget("vimpi-todo", undefined);
}

export function toggleTodos(): void {
	expanded = !expanded;
	state.requestRender();
}

export function registerTodo(pi: ExtensionAPI): void {
	pi.on("session_start", (_e, ctx) => rebuild(ctx));
	pi.on("session_tree", (_e, ctx) => rebuild(ctx));

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description: "Track a multi-step task as a todo list the user sees above the prompt. Returns the whole list.",
		promptSnippet: "todo: track multi-step work as a visible checklist",
		promptGuidelines: [
			"For tasks with three or more steps, add them with the todo tool first and mark each done as you finish it.",
		],
		parameters: Params,
		async execute(_id, params) {
			const { list: next, error } = applyTodo(list, params as TodoParams);
			if (error) throw new Error(error);
			list = next;
			state.requestRender();
			const details: TodoDetails = { ...list, action: (params as TodoParams).action };
			return { content: [{ type: "text", text: formatTodos(list) }], details };
		},
	});

	pi.registerCommand("todos", {
		description: "Expand or collapse the todo list above the prompt",
		handler: async () => toggleTodos(),
	});
}
