/**
 * Loop — `/loop [interval] <prompt>`
 *
 * Re-submit a prompt into this session on a repeating basis, myflicker-style:
 * either on a fixed interval, or self-paced where the model decides when to run
 * again. Intended for polling work — "check whether the leg reached iteration
 * 12", "re-run the suite until it is green" — where the useful cadence is only
 * known after seeing the previous result.
 *
 * Usage:
 *   /loop 10m check whether the fp8 leg reached iteration 12
 *   /loop --max 5 poll the job status
 *   /loop --until the three tables are filled compare BF16 and FP8 reserved
 *   /loop status
 *   /loop stop
 *
 * Self-paced mode (no interval) has no timer at all: the next iteration is armed
 * by the model's own marker, so a step that takes 40 minutes does not stack up
 * 40 queued runs behind it.
 *
 * Markers the model emits to drive a self-paced loop:
 *   [loop-next: 5m]   run again after 5m
 *   [loop-done]       stop the loop
 *
 * Design notes:
 *   - Timers are armed in session_start and cleared in session_shutdown, per the
 *     extension lifecycle contract; never in the factory, because some
 *     invocations load extensions without starting a session.
 *   - A beat is skipped (not queued) while a run is in flight. Queueing would
 *     silently pile up work whenever the task is slower than the interval.
 *   - `--until` is not an evaluator. The condition is carried into the prompt and
 *     the model signals completion with [loop-done]; pretending to evaluate an
 *     arbitrary condition here would be a lie.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CUSTOM_TYPE = "loop-state";
const MIN_INTERVAL_MS = 10_000;
const DEFAULT_SELF_PACED_MS = 60_000;

interface LoopPersisted {
	active: boolean;
	prompt: string;
	/** null means self-paced: the model's marker decides the delay. */
	intervalMs: number | null;
	maxIterations: number | null;
	until: string | null;
	iteration: number;
}

interface Runtime extends LoopPersisted {
	busy: boolean;
}

const EMPTY: LoopPersisted = {
	active: false,
	prompt: "",
	intervalMs: null,
	maxIterations: null,
	until: null,
	iteration: 0,
};

function readState(entries: readonly any[]): LoopPersisted {
	let state: LoopPersisted = { ...EMPTY };
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === CUSTOM_TYPE) {
			const data = entry.data ?? {};
			state = {
				active: Boolean(data.active),
				prompt: typeof data.prompt === "string" ? data.prompt : "",
				intervalMs: typeof data.intervalMs === "number" ? data.intervalMs : null,
				maxIterations: typeof data.maxIterations === "number" ? data.maxIterations : null,
				until: typeof data.until === "string" ? data.until : null,
				iteration: typeof data.iteration === "number" ? data.iteration : 0,
			};
		}
	}
	return state;
}

/** Parse `30s`, `10m`, `2h` into milliseconds. */
function parseDuration(raw: string): number | null {
	const match = /^(\d+)\s*(s|m|h)$/i.exec(raw.trim());
	if (!match) return null;
	const n = Number(match[1]);
	if (!Number.isFinite(n) || n <= 0) return null;
	const unit = match[2].toLowerCase();
	return n * (unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000);
}

function formatDuration(ms: number): string {
	if (ms >= 3_600_000) return `${ms / 3_600_000}h`;
	if (ms >= 60_000) return `${ms / 60_000}m`;
	return `${ms / 1000}s`;
}

/** Find the last assistant text in the session, for marker parsing. */
function lastAssistantText(entries: readonly any[]): string {
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		if (entry.message?.role !== "assistant") continue;
		const parts = entry.message.content ?? [];
		const text = parts
			.filter((part: any) => part.type === "text" && part.text)
			.map((part: any) => part.text)
			.join("\n");
		if (text) return text;
	}
	return "";
}

export default function (pi: ExtensionAPI) {
	const runtime: Runtime = { ...EMPTY, busy: false };
	let timer: ReturnType<typeof setTimeout> | null = null;

	const clearTimer = () => {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
	};

	const persist = () => {
		pi.appendEntry(CUSTOM_TYPE, {
			active: runtime.active,
			prompt: runtime.prompt,
			intervalMs: runtime.intervalMs,
			maxIterations: runtime.maxIterations,
			until: runtime.until,
			iteration: runtime.iteration,
		});
	};

	const stop = (reason: string, ctx?: { ui: { notify: (m: string, l: any) => void; setStatus: (k: string, v?: string) => void } }) => {
		runtime.active = false;
		clearTimer();
		persist();
		ctx?.ui.setStatus("loop", undefined);
		if (ctx) ctx.ui.notify(`loop stopped: ${reason} (${runtime.iteration} iteration(s))`, "info");
	};

	const composePrompt = (): string => {
		const lines = [
			`<loop-iteration n="${runtime.iteration}"${runtime.maxIterations != null ? ` of="${runtime.maxIterations}"` : ""}>`,
			runtime.prompt,
		];
		if (runtime.until) {
			lines.push("", `Completion condition: ${runtime.until}`);
			lines.push("If this condition is now satisfied, end your reply with [loop-done].");
		}
		if (runtime.intervalMs === null) {
			lines.push(
				"",
				"This is a self-paced loop. End your reply with exactly one marker:",
				"  [loop-next: 5m]  to run again after that delay, or",
				"  [loop-done]      to stop the loop.",
			);
		}
		lines.push("</loop-iteration>");
		return lines.join("\n");
	};

	const arm = (delayMs: number) => {
		clearTimer();
		timer = setTimeout(() => {
			void beat();
		}, delayMs);
		// Do not hold the process open on account of a pending beat.
		(timer as any)?.unref?.();
	};

	const beat = async () => {
		timer = null;
		if (!runtime.active) return;

		if (runtime.maxIterations != null && runtime.iteration >= runtime.maxIterations) {
			stop("max iterations reached");
			return;
		}

		if (runtime.busy) {
			// Skip rather than queue: a task slower than the interval must not
			// accumulate a backlog of duplicate runs.
			if (runtime.intervalMs !== null) arm(runtime.intervalMs);
			return;
		}

		runtime.iteration += 1;
		persist();
		pi.sendUserMessage(composePrompt(), { deliverAs: "followUp" });

		// Fixed interval re-arms from the fire, not from completion, so a slow
		// iteration delays the next beat instead of doubling up.
		if (runtime.intervalMs !== null) arm(runtime.intervalMs);
	};

	pi.on("agent_start", async () => {
		runtime.busy = true;
	});

	// agent_settled is the final boundary: no automatic retry, compaction, or
	// queued continuation will run after it. That makes it the right place to
	// decide the next self-paced beat.
	pi.on("agent_settled", async (_event, ctx) => {
		runtime.busy = false;
		if (!runtime.active || runtime.intervalMs !== null) return;

		const entries = ctx.sessionManager?.getEntries?.() ?? [];
		const text = lastAssistantText(entries);

		if (/\[loop-done\]/.test(text)) {
			stop("model signalled [loop-done]", ctx);
			return;
		}
		const next = /\[loop-next:\s*(\d+)\s*(s|m|h)\s*\]/i.exec(text);
		if (next) {
			const ms = parseDuration(`${next[1]}${next[2]}`);
			if (ms !== null && ms >= MIN_INTERVAL_MS) {
				arm(ms);
				return;
			}
		}
		// No marker from a self-paced loop: fall back to a conservative delay
		// rather than spinning immediately.
		arm(DEFAULT_SELF_PACED_MS);
	});

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager?.getEntries?.() ?? [];
		const saved = readState(entries);
		Object.assign(runtime, saved, { busy: false });
		clearTimer();
		if (!runtime.active) return;

		ctx.ui.setStatus("loop", `loop: iter ${runtime.iteration}`);
		if (runtime.intervalMs !== null) {
			arm(runtime.intervalMs);
		}
		// Self-paced loops re-arm from the next agent_settled, not from startup.
	});

	pi.on("session_shutdown", async () => {
		clearTimer();
		runtime.active = false;
		runtime.busy = false;
	});

	pi.registerCommand("loop", {
		description: "Re-submit a prompt on an interval, or self-paced until done",
		handler: async (args, ctx) => {
			const raw = (args ?? "").trim();

			if (!raw || raw === "status") {
				if (!runtime.active) {
					ctx.ui.notify("No active loop. Usage: /loop [interval] <prompt>", "info");
					return;
				}
				const pace = runtime.intervalMs !== null ? `every ${formatDuration(runtime.intervalMs)}` : "self-paced";
				const cap = runtime.maxIterations != null ? `, max ${runtime.maxIterations}` : "";
				ctx.ui.notify(
					`loop running (${pace}${cap}), iteration ${runtime.iteration}\n  ${runtime.prompt}` +
						(runtime.until ? `\n  until: ${runtime.until}` : ""),
					"info",
				);
				return;
			}

			if (raw === "stop") {
				if (!runtime.active) {
					ctx.ui.notify("No active loop.", "info");
					return;
				}
				stop("requested", ctx);
				return;
			}

			// Parse leading flags, then an optional interval, then the prompt.
			let rest = raw;
			let maxIterations: number | null = null;
			let until: string | null = null;
			for (;;) {
				const flag = /^--(max|until)\s+(\S+)(?:\s+|$)/.exec(rest);
				if (!flag) break;
				if (flag[1] === "max") {
					const n = Number(flag[2]);
					if (!Number.isInteger(n) || n <= 0) {
						ctx.ui.notify("--max expects a positive integer.", "error");
						return;
					}
					maxIterations = n;
				} else {
					until = flag[2];
				}
				rest = rest.slice(flag[0].length);
			}

			let intervalMs: number | null = null;
			const intervalMatch = /^(\d+)\s*(s|m|h)\s+/i.exec(rest);
			if (intervalMatch) {
				const parsed = parseDuration(`${intervalMatch[1]}${intervalMatch[2]}`);
				if (parsed === null || parsed < MIN_INTERVAL_MS) {
					ctx.ui.notify(`Minimum interval is ${formatDuration(MIN_INTERVAL_MS)}.`, "error");
					return;
				}
				intervalMs = parsed;
				rest = rest.slice(intervalMatch[0].length);
			}

			const prompt = rest.trim();
			if (!prompt) {
				ctx.ui.notify("A prompt is required. Usage: /loop [interval] <prompt>", "error");
				return;
			}

			clearTimer();
			Object.assign(runtime, {
				active: true,
				prompt,
				intervalMs,
				maxIterations,
				until,
				iteration: 0,
				busy: false,
			});
			persist();
			ctx.ui.setStatus("loop", "loop: starting");

			// Start immediately: waiting one interval before the first run is
			// almost never what the caller wants.
			await beat();
			ctx.ui.notify(
				`loop started (${intervalMs !== null ? `every ${formatDuration(intervalMs)}` : "self-paced"}` +
					`${maxIterations != null ? `, max ${maxIterations}` : ""}) → ${prompt}`,
				"info",
			);
		},
	});
}
