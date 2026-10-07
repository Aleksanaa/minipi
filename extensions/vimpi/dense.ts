/**
 * "dense" density: strips pi's spacer rows from the transcript and lets the
 * editor dock shrink to a single row.
 *
 * Transcript rule: drop every blank line, except one between two prose
 * lines (paragraphs, code). Tool rows (marked with TOOL) and user prompts are visually
 * distinct already, so they need no spacing. User-prompt padding rows carry
 * OSC 133 markers that [[ / ]] rely on; those markers move to a kept line.
 *
 * Both hooks are applied to this TUI instance only and undone when
 * switching to the compact density.
 */

import type { TUI } from "@earendil-works/pi-tui";

// biome-ignore lint/suspicious/noExplicitAny: reaching into TUI internals
type Any = any;

const ESC_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const OSC133_RE = /\x1b\]133;[A-Z][^\x07\x1b]*(?:\x07|\x1b\\)/g;
/** Prefix (a no-op SGR pair) marking lines the filter must keep verbatim, blank or not. */
export const KEEP = "\x1b[8m\x1b[28m";
/** Prefix (another no-op SGR sequence) marking a tool row's call line. */
export const TOOL = "\x1b[8m\x1b[29m\x1b[28m";

type Kind = "blank" | "tool" | "body" | "user" | "text" | "keep";

export function densify(lines: string[]): string[] {
	const out: string[] = [];
	let inUser = false;
	let inTool = false;
	let lastKind: Kind = "blank";
	let gap = false;
	let carry = "";
	for (const line of lines) {
		if (line.startsWith(KEEP)) {
			out.push(carry + line);
			carry = "";
			gap = false;
			lastKind = "keep";
			continue;
		}
		if (line.includes("\x1b]133;A")) inUser = true;
		const plain = line.replace(ESC_RE, "");
		const blank = !plain.trim();
		let kind: Kind;
		if (blank) kind = "blank";
		else if (inUser) kind = "user";
		else if (line.startsWith(TOOL)) kind = "tool";
		else if (inTool && plain.startsWith("  ")) kind = "body";
		else kind = "text";
		if (line.includes("\x1b]133;B")) inUser = false;
		if (kind === "tool") inTool = true;
		else if (kind !== "body" && kind !== "blank") inTool = false;

		if (kind === "blank") {
			const markers = line.match(OSC133_RE)?.join("") ?? "";
			// Zone start belongs to the next line; zone end to the previous one.
			if (markers.includes("133;A") || out.length === 0) carry += markers;
			else if (markers) out[out.length - 1] = markers + out[out.length - 1];
			gap = true;
			continue;
		}
		if (gap && lastKind === "text" && kind === "text") out.push("");
		out.push(carry + line);
		carry = "";
		gap = false;
		lastKind = kind;
	}
	if (carry && out.length) out[out.length - 1] = carry + out[out.length - 1];
	return out;
}

type Renderable = { render: (w: number) => string[] };

const patched = new WeakMap<object, (() => void)[]>();

/** Wrap a component's render on this instance only; returns the undo. */
function wrapRender(c: Renderable, f: (lines: string[]) => string[]): () => void {
	const own = Object.hasOwn(c, "render");
	const render = c.render;
	c.render = (w: number) => f(render.call(c, w));
	return () => {
		if (own) c.render = render;
		else delete (c as Any).render;
	};
}

function dropLeadingBlanks(lines: string[]): string[] {
	let i = 0;
	while (i < lines.length && !lines[i]!.replace(ESC_RE, "").trim()) i++;
	return i ? lines.slice(i) : lines;
}

/** Install the transcript filter and single-row dock on a fullscreen TUI. Idempotent. */
export function applyDense(tui: TUI): void {
	const t = tui as Any;
	const root = t.layoutRoot;
	if (!root || patched.has(root)) return;
	const doc = root.entries?.[0]?.component?.child;
	const dock = root.entries?.[1]?.component;
	if (!doc || typeof doc.render !== "function") return;
	const undo = [wrapRender(doc, densify)];
	// The editor slot has minSize 3; the slot just above it holds widgets and
	// pads itself with a spacer row even when empty.
	const entries: { minSize?: number; component: Renderable }[] = dock?.entries ?? [];
	const slotIdx = entries.findIndex((e) => e.minSize === 3);
	const slot = entries[slotIdx];
	if (slot) {
		slot.minSize = 1;
		undo.push(() => {
			slot.minSize = 3;
		});
		const above = entries[slotIdx - 1]?.component;
		if (above && typeof above.render === "function") undo.push(wrapRender(above, dropLeadingBlanks));
	}
	patched.set(root, undo);
	t.requestRender?.();
}

export function removeDense(tui: TUI): void {
	const t = tui as Any;
	const root = t.layoutRoot;
	const undo = root && patched.get(root);
	if (!undo) return;
	for (const u of undo) u();
	patched.delete(root);
	t.requestRender?.();
}

// ---------------------------------------------------------------------------
// Startup resource listing

const INVENTORY_RE = /^\[(Context|Extensions|Prompts|Skills)\]$/;

/** Drop pi's [Extensions]/[Skills]/… inventory but keep warning sections such as [Extension issues]. */
export function dropInventory(lines: string[]): string[] {
	const out: string[] = [];
	let skipping = false;
	for (const line of lines) {
		const plain = line.replace(ESC_RE, "").trim();
		if (INVENTORY_RE.test(plain)) skipping = true;
		else if (skipping && !plain) {
			skipping = false;
			continue;
		}
		if (!skipping) out.push(line);
	}
	return out;
}

const listings = new WeakSet<object>();

/**
 * The start screen summarizes loaded resources, so pi's own listing (the
 * second child of the transcript document) is filtered. Idempotent.
 */
export function hideResourceListing(tui: TUI): void {
	const root = (tui as Any).layoutRoot;
	if (!root || listings.has(root)) return;
	const listing = root.entries?.[0]?.component?.child?.children?.[1];
	if (!listing || typeof listing.render !== "function") return;
	listings.add(root);
	wrapRender(listing, dropInventory);
	(tui as Any).requestRender?.();
}
