/**
 * Blocks the model's write/edit calls on secrets and tool-owned trees,
 * after pi's protected-paths example but matching whole path segments
 * (so .envrc and env.ts stay editable).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function isProtected(path: string): boolean {
	const parts = path.split(/[\\/]+/);
	const base = parts[parts.length - 1] ?? "";
	if (/^\.env(\..+)?$/.test(base) && base !== ".env.example") return true;
	return parts.some((p) => p === ".git" || p === "node_modules");
}

export function registerGuard(pi: ExtensionAPI): void {
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "edit") return;
		const path = (event.input as { path?: unknown }).path;
		if (typeof path !== "string" || !isProtected(path)) return;
		if (ctx.hasUI) ctx.ui.notify(`Blocked write to ${path}`, "warning");
		return { block: true, reason: `Path "${path}" is protected; ask the user to change it.` };
	});
}
