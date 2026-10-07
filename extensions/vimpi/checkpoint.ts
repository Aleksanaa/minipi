/**
 * Code checkpoints for /fork, after pi's git-checkpoint example.
 *
 * Each prompt records `git stash create` (a commit of the dirty tree, or
 * nothing when clean) plus HEAD, keyed by the prompt's session entry.
 * Forking from that prompt offers to put the code back. The current
 * changes are stashed first, so a restore never loses work.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface Checkpoint {
	head: string;
	stash: string;
}

export function registerCheckpoints(pi: ExtensionAPI): void {
	const points = new Map<string, Checkpoint>();
	const git = async (...args: string[]) => {
		const r = await pi.exec("git", args);
		return { ok: r.code === 0, out: r.stdout.trim(), err: r.stderr.trim() };
	};

	// Snapshot before the agent touches anything; the prompt's entry id is
	// only known once the first turn has been persisted.
	let pending: Promise<Checkpoint | undefined> | undefined;
	pi.on("agent_start", () => {
		pending = (async () => {
			const head = await git("rev-parse", "HEAD");
			if (!head.ok) return undefined; // not a git repo, or no commits yet
			const stash = await git("stash", "create");
			return { head: head.out, stash: stash.ok ? stash.out : "" };
		})();
	});
	pi.on("turn_end", async (_e, ctx) => {
		if (!pending) return;
		const cp = await pending;
		pending = undefined;
		const prompt = ctx.sessionManager
			.getBranch()
			.findLast((e) => e.type === "message" && e.message.role === "user");
		if (cp && prompt) points.set(prompt.id, cp);
	});

	pi.on("session_before_fork", async (event, ctx) => {
		const cp = points.get(event.entryId);
		if (!cp || !ctx.hasUI) return;
		const head = await git("rev-parse", "HEAD");
		if (head.out !== cp.head) {
			ctx.ui.notify("Code not restored: HEAD moved since that prompt", "warning");
			return;
		}
		const choice = await ctx.ui.select("Restore code to that prompt?", ["Yes, restore code", "No, keep current code"]);
		if (!choice?.startsWith("Yes")) return;
		const dirty = await git("status", "--porcelain", "--untracked-files=no");
		if (dirty.out) {
			const saved = await git("stash", "push", "-m", `pi: before restoring checkpoint ${event.entryId}`);
			if (!saved.ok) return ctx.ui.notify(`Code not restored: ${saved.err}`, "error");
		}
		if (cp.stash) {
			const applied = await git("stash", "apply", cp.stash);
			if (!applied.ok) return ctx.ui.notify(`Restore failed: ${applied.err}`, "error");
		}
		ctx.ui.notify(dirty.out ? "Code restored; previous state is in git stash" : "Code restored", "info");
	});
}
