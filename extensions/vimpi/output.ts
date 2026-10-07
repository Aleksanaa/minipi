/**
 * Terminal output filter:
 * - rewrites every SGR color to the 3-bit codes 30-37 / 40-47, for screens
 *   that only know 8 colors (pi always emits 256-color or truecolor
 *   sequences, even for the basic palette);
 * - drops pi's frames while its default UI is up (startup and session
 *   switches, before vimpi is bound), so that UI never reaches the screen.
 */

/** Nearest basic color (0-7) for a 256-palette index. */
function fromIndex(i: number, fg: boolean): number {
	if (i < 8) return i;
	if (i < 16) return i === 8 ? (fg ? 7 : 0) : i - 8; // bright gray reads as white text
	if (i < 232) {
		const n = i - 16;
		const bit = (v: number) => (v >= 3 ? 1 : 0);
		return bit(Math.floor(n / 36)) | (bit(Math.floor(n / 6) % 6) << 1) | (bit(n % 6) << 2);
	}
	return gray(8 + 10 * (i - 232), fg);
}

function fromRgb(r: number, g: number, b: number, fg: boolean): number {
	const max = Math.max(r, g, b);
	if (max - Math.min(r, g, b) < 48) return gray(max, fg);
	const bit = (v: number) => (v >= max / 2 && v >= 96 ? 1 : 0);
	return bit(r) | (bit(g) << 1) | (bit(b) << 2);
}

/** Grays: visible text stays white, only real light backgrounds stay white. */
function gray(level: number, fg: boolean): number {
	return fg ? (level < 40 ? 0 : 7) : level > 200 ? 7 : 0;
}

function convert(params: string): string {
	const p = params.split(/[;:]/);
	const out: string[] = [];
	for (let i = 0; i < p.length; i++) {
		const n = Number(p[i] || 0);
		if ((n === 38 || n === 48) && p[i + 1] === "5") {
			out.push(String((n === 38 ? 30 : 40) + fromIndex(Number(p[i + 2]), n === 38)));
			i += 2;
		} else if ((n === 38 || n === 48) && p[i + 1] === "2") {
			// 38;2;R;G;B, or the colon form with an empty colorspace id: 38:2::R:G:B
			const off = p.length - i >= 6 && p[i + 2] === "" ? 3 : 2;
			const [r, g, b] = [p[i + off], p[i + off + 1], p[i + off + 2]].map(Number) as [number, number, number];
			out.push(String((n === 38 ? 30 : 40) + fromRgb(r, g, b, n === 38)));
			i += off + 2;
		} else if (n >= 90 && n <= 97) out.push(String(n === 90 ? 37 : n - 60));
		else if (n >= 100 && n <= 107) out.push(String(n - 60));
		else out.push(p[i]!);
	}
	return out.join(";");
}

export function to8Colors(data: string): string {
	return data.includes("\x1b[") ? data.replace(/\x1b\[([0-9;:]*)m/g, (_, ps: string) => `\x1b[${convert(ps)}m`) : data;
}

// ---------------------------------------------------------------------------
// The stdout hook

// biome-ignore lint/suspicious/noExplicitAny: mirrors stream.write's overloads
type Write = (chunk: any, ...rest: any[]) => boolean;

interface Hook {
	held: boolean;
	timer?: ReturnType<typeof setTimeout>;
	screen?: { requestRender(force?: boolean): void };
}

/** Longest hold, in case vimpi never shows up (e.g. it failed to load). */
const HOLD_MS = 3000;

// pi loads extensions afresh for every session, so the hook lives on the
// stream itself, shared by the old and the new vimpi instance.
const HOOK = Symbol.for("vimpi.output");

/**
 * A fullscreen frame. Setup and teardown (alt screen, autowrap) are written
 * in synchronized blocks too, but always pass: dropping them could leave
 * the terminal broken.
 */
function isFrame(s: string): boolean {
	return s.startsWith("\x1b[?2026h") && !s.includes("\x1b[?1049") && !s.includes("\x1b[?7h");
}

/** Wrap `stream.write` once: colors become 3-bit, frames are dropped while held. */
export function attachOutput(stream: { write: Write } = process.stdout): Hook {
	const s = stream as { write: Write; [HOOK]?: Hook };
	const existing = s[HOOK];
	if (existing) return existing;
	const hook: Hook = { held: false };
	const write = s.write.bind(s);
	s.write = (chunk, ...rest) => {
		if (typeof chunk !== "string") return write(chunk, ...rest);
		if (hook.held && isFrame(chunk)) {
			rest.find((a) => typeof a === "function")?.();
			return true;
		}
		return write(to8Colors(chunk), ...rest);
	};
	s[HOOK] = hook;
	return hook;
}

function release(hook: Hook): void {
	clearTimeout(hook.timer);
	hook.held = false;
	hook.screen?.requestRender(true); // full repaint: the terminal never saw the dropped frames
}

/**
 * Drop frames until vimpi's UI is installed. pi renders its default UI at
 * startup and after every session switch before extensions are bound;
 * this keeps that from ever reaching the screen.
 */
export function holdOutput(hook = attachOutput()): void {
	hook.held = true;
	clearTimeout(hook.timer);
	hook.timer = setTimeout(() => release(hook), HOLD_MS).unref();
}

/** vimpi's UI is in place: end the hold and repaint everything. */
export function releaseOutput(screen: { requestRender(force?: boolean): void }, hook = attachOutput()): void {
	hook.screen = screen;
	release(hook);
}
