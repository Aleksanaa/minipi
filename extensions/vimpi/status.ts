/**
 * Shared runtime state and the priority-based border layout used to fit
 * model, context, git and mode information into a single row.
 */

import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

interface Stats {
	cost: number;
	percent: number | null;
	window: number;
}

export const state = {
	/** "dense": one-row input bar, no spacer rows. "compact": bordered editor. */
	density: "dense" as "dense" | "compact",
	pi: undefined as ExtensionAPI | undefined,
	ctx: undefined as ExtensionContext | undefined,
	footer: undefined as ReadonlyFooterDataProvider | undefined,
	stats: { cost: 0, percent: null, window: 0 } as Stats,
	requestRender: () => {},
};

/**
 * Color roles (themes/basic8.json): text = content, muted/dim = chrome,
 * accent = paths and other things you can open, KEY = keys and commands
 * you type, warning = busy or attention, success / error = done / failed.
 * pi themes have no key color; syntaxKeyword (magenta in basic8) stands in.
 */
export const KEY = "syntaxKeyword";

export function refreshStats(ctx: ExtensionContext): void {
	let cost = 0;
	try {
		for (const e of ctx.sessionManager.getBranch()) {
			if (e.type === "message" && e.message.role === "assistant") cost += e.message.usage?.cost?.total ?? 0;
		}
	} catch {
		// Session may be mid-replacement; keep the old total.
		cost = state.stats.cost;
	}
	const usage = ctx.getContextUsage();
	state.stats = { cost, percent: usage?.percent ?? null, window: usage?.contextWindow ?? 0 };
	state.requestRender();
}

export function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${Math.round(n / 1000)}k`;
	return `${n}`;
}

export function shortModel(id: string | undefined): string {
	if (!id) return "no model";
	return id
		.replace(/^.*\//, "")
		.replace(/^claude-/, "")
		.replace(/-\d{8}$/, "")
		.replace(/-latest$/, "");
}

const THINKING_ABBR: Record<string, [string, Parameters<Theme["fg"]>[0]]> = {
	minimal: ["min", "thinkingMinimal"],
	low: ["lo", "thinkingLow"],
	medium: ["med", "thinkingMedium"],
	high: ["hi", "thinkingHigh"],
	xhigh: ["xhi", "thinkingXhigh"],
	max: ["max", "thinkingMax"],
};

export function thinkingTag(theme: Theme, level: string | undefined): string | undefined {
	const t = level ? THINKING_ABBR[level] : undefined;
	return t ? theme.fg(t[1], t[0]) : undefined;
}

// ---------------------------------------------------------------------------
// Border layout

export interface Seg {
	text: string;
	/** Higher survives longer when the row is too narrow. */
	pri: number;
}

/**
 * Lay out `─ L1 L2 ─────── R1 R2 ─`, dropping the lowest-priority segments
 * until the row fits. `lead` controls the leading `─ ` before the left group.
 */
export function borderRow(
	width: number,
	left: Seg[],
	right: Seg[],
	line: (s: string) => string,
	lead = true,
): string {
	const all = [...left.map((s) => ({ ...s, side: 0 })), ...right.map((s) => ({ ...s, side: 1 }))].filter((s) => s.text);
	const used = () => {
		const l = all.filter((s) => s.side === 0);
		const r = all.filter((s) => s.side === 1);
		const w = (xs: typeof all) => xs.reduce((n, s) => n + visibleWidth(s.text), 0) + Math.max(0, xs.length - 1);
		return (l.length ? w(l) + (lead ? 3 : 1) : 0) + (r.length ? w(r) + 3 : 0) + 1;
	};
	while (all.length && used() > width) {
		let drop = 0;
		for (let i = 1; i < all.length; i++) if (all[i]!.pri <= all[drop]!.pri) drop = i;
		all.splice(drop, 1);
	}
	const l = all.filter((s) => s.side === 0).map((s) => s.text);
	const r = all.filter((s) => s.side === 1).map((s) => s.text);
	let out = "";
	if (l.length) out += (lead ? line("─ ") : "") + l.join(" ") + " ";
	const rightText = r.length ? ` ${r.join(" ")} ${line("─")}` : "";
	const fill = Math.max(0, width - visibleWidth(out) - visibleWidth(rightText));
	out += line("─".repeat(fill)) + rightText;
	return visibleWidth(out) > width ? truncateToWidth(out, width, "") : out;
}

/** Truncate in the middle, keeping both ends (useful for paths). */
export function truncMid(s: string, max: number): string {
	if (max <= 0) return "";
	if (s.length <= max) return s;
	if (max <= 1) return "…";
	const head = Math.ceil((max - 1) / 3);
	const tail = max - 1 - head;
	return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}
