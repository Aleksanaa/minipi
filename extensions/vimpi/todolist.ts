/**
 * Pure todo-list model for the `todo` tool. State lives in tool result
 * details, so branching the session also branches the list.
 */

export interface Todo {
	id: number;
	text: string;
	done: boolean;
}

export interface TodoList {
	todos: Todo[];
	nextId: number;
}

export type TodoAction = "list" | "add" | "done" | "undo" | "remove" | "clear";

export interface TodoParams {
	action: TodoAction;
	items?: string[];
	ids?: number[];
}

export interface TodoDetails extends TodoList {
	action: TodoAction;
}

export const emptyTodos = (): TodoList => ({ todos: [], nextId: 1 });

export function formatTodos(list: TodoList): string {
	if (!list.todos.length) return "No todos.";
	return list.todos.map((t) => `[${t.done ? "x" : " "}] ${t.id}. ${t.text}`).join("\n");
}

/** Applies one tool call; never mutates `list`. */
export function applyTodo(list: TodoList, p: TodoParams): { list: TodoList; error?: string } {
	const todos = list.todos.map((t) => ({ ...t }));
	let nextId = list.nextId;
	const ids = p.ids ?? [];
	const missing = ids.filter((id) => !todos.some((t) => t.id === id));
	switch (p.action) {
		case "list":
			return { list };
		case "add": {
			const items = (p.items ?? []).map((s) => s.trim()).filter(Boolean);
			if (!items.length) return { list, error: "add needs items" };
			for (const text of items) todos.push({ id: nextId++, text, done: false });
			return { list: { todos, nextId } };
		}
		case "done":
		case "undo":
		case "remove": {
			if (!ids.length) return { list, error: `${p.action} needs ids` };
			if (missing.length) return { list, error: `no todo ${missing.join(", ")}` };
			if (p.action === "remove") return { list: { todos: todos.filter((t) => !ids.includes(t.id)), nextId } };
			for (const t of todos) if (ids.includes(t.id)) t.done = p.action === "done";
			return { list: { todos, nextId } };
		}
		case "clear":
			return { list: emptyTodos() };
	}
	return { list, error: `unknown action ${p.action}` };
}

export function progress(list: TodoList): { done: number; total: number; next?: Todo } {
	return {
		done: list.todos.filter((t) => t.done).length,
		total: list.todos.length,
		next: list.todos.find((t) => !t.done),
	};
}
