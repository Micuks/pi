/**
 * Goal — `/goal <objective>`
 *
 * A standing objective that survives compaction and is re-injected into every
 * run. The point is durability: a long session that compacts loses the original
 * ask, and the model then optimizes for whatever survived. A goal is kept as a
 * session entry (so it branches with the session) and prepended as a short
 * reminder at the start of each run.
 *
 * Usage:
 *   /goal run the BF16/FP8 memory diff and produce the three-stage tables
 *   /goal                      show the current goal
 *   /goal clear                remove it
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CUSTOM_TYPE = "goal";

interface GoalState {
	goal: string | null;
	setAt: string | null;
}

function readGoal(entries: readonly any[]): GoalState {
	let state: GoalState = { goal: null, setAt: null };
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === CUSTOM_TYPE) {
			const data = entry.data ?? {};
			state = { goal: data.goal ?? null, setAt: data.setAt ?? null };
		}
	}
	return state;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("goal", {
		description: "Set, show, or clear the standing objective for this session",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim();
			const entries = ctx.sessionManager?.getEntries?.() ?? [];
			const current = readGoal(entries);

			if (!arg) {
				if (!current.goal) {
					ctx.ui.notify("No goal set. Usage: /goal <objective>", "info");
					return;
				}
				ctx.ui.notify(`goal (set ${current.setAt}): ${current.goal}`, "info");
				return;
			}

			if (arg.toLowerCase() === "clear") {
				pi.appendEntry(CUSTOM_TYPE, { goal: null, setAt: null });
				ctx.ui.notify("goal cleared", "info");
				return;
			}

			const setAt = new Date().toISOString();
			pi.appendEntry(CUSTOM_TYPE, { goal: arg, setAt });
			ctx.ui.notify(`goal set: ${arg}`, "info");
		},
	});

	// Re-inject the goal at the start of each run.
	//
	// The result must be a CustomMessage shape (`customType` + `display`), not a
	// bare user message: Pi stores it as a `custom_message` entry. Returning a
	// partial object is silently ineffective, which is why the fields are spelled
	// out here rather than assembled inline.
	pi.on("before_agent_start", async (event, ctx) => {
		if (event.messageType !== "user") return;
		const entries = ctx.sessionManager?.getEntries?.() ?? [];
		const { goal } = readGoal(entries);
		if (!goal) return;
		return {
			message: {
				customType: "goal-reminder",
				display: true,
				content: [
					{
						type: "text",
						text: `<standing-goal>\n${goal}\n</standing-goal>\n\nKeep this objective in view. If the current request conflicts with it, say so before proceeding.`,
					},
				],
			},
		};
	});
}
