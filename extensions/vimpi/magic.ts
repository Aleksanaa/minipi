/**
 * Magic keywords (borrowed from oh-my-pi): a standalone word in the prompt
 * adds a hidden instruction for that turn.
 *
 *   ultrathink  highest thinking level for this run, careful reasoning
 *   stepwise    plan with the todo tool first, then work through it
 *   tldr        keep the reply short enough for a small terminal
 *
 * Words inside code spans, fences, paths or identifiers do not count.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Level = ReturnType<ExtensionAPI["getThinkingLevel"]>;

const KEYWORDS: Record<string, string> = {
	ultrathink:
		"The user asked you to ultrathink: reason carefully and step by step, consider alternatives and failure modes, and verify before answering.",
	stepwise:
		"The user asked you to work stepwise: first break the task into steps with the todo tool, then do them in order and mark each done.",
	tldr: "The user reads on a 66x20 terminal: keep the final reply to at most 6 short lines. No preamble, no recap.",
};

/** Keywords that appear as standalone prose words in `prompt`. */
export function findKeywords(prompt: string): string[] {
	const prose = prompt.replace(/```[\s\S]*?(```|$)/g, " ").replace(/`[^`\n]*`/g, " ");
	return Object.keys(KEYWORDS).filter((k) => new RegExp(`(?<![\\w/.\\-])${k}(?![\\w/\\-]|\\.\\w)`, "i").test(prose));
}

export function registerMagic(pi: ExtensionAPI): void {
	let restore: Level | undefined;

	pi.on("before_agent_start", (event) => {
		const found = findKeywords(event.prompt);
		if (!found.length) return;
		if (found.includes("ultrathink") && restore === undefined) {
			restore = pi.getThinkingLevel();
			pi.setThinkingLevel("max");
		}
		return {
			message: {
				customType: "vimpi-magic",
				content: found.map((k) => KEYWORDS[k]).join("\n"),
				display: false,
				details: { keywords: found },
			},
		};
	});

	pi.on("agent_settled", () => {
		if (restore === undefined) return;
		pi.setThinkingLevel(restore);
		restore = undefined;
	});
}
