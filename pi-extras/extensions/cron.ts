/**
 * Cron — `/cron ...`
 *
 * Schedule a prompt to be re-submitted into this session on a repeating basis.
 * Useful for long-running work: poll a job, re-check a metric, re-run a suite
 * every N minutes. This is a scheduler on top of the session, not an OS cron:
 * jobs live only while the session is open, which is what you want when the
 * prompt depends on the conversation.
 *
 * Usage:
 *   /cron add every 10m check whether the fp8 leg has reached iteration 12
 *   /cron add at 09:30 summarize the overnight runs
 *   /cron list
 *   /cron remove 1
 *
 * Timers are created on session_start and cleared on session_shutdown, per the
 * extension lifecycle contract — never in the factory, because some invocations
 * load extensions without starting a session.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CUSTOM_TYPE = "cron-jobs";

interface Job {
	id: number;
	kind: "every" | "at";
	/** Interval in ms for "every"; minutes-past-midnight for "at". */
	value: number;
	prompt: string;
	createdAt: string;
}

interface CronState {
	jobs: Job[];
	nextId: number;
}

function readState(entries: readonly any[]): CronState {
	let state: CronState = { jobs: [], nextId: 1 };
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === CUSTOM_TYPE) {
			const data = entry.data ?? {};
			state = {
				jobs: Array.isArray(data.jobs) ? data.jobs : [],
				nextId: typeof data.nextId === "number" ? data.nextId : 1,
			};
		}
	}
	return state;
}

/** Parse `10m`, `90s`, `2h` into milliseconds. */
function parseDuration(raw: string): number | null {
	const match = /^(\d+)\s*(s|m|h)$/i.exec(raw.trim());
	if (!match) return null;
	const n = Number(match[1]);
	if (!Number.isFinite(n) || n <= 0) return null;
	const unit = match[2].toLowerCase();
	return n * (unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000);
}

/** Parse `HH:MM` into minutes past midnight. */
function parseTimeOfDay(raw: string): number | null {
	const match = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
	if (!match) return null;
	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	if (hours > 23 || minutes > 59) return null;
	return hours * 60 + minutes;
}

function describe(job: Job): string {
	if (job.kind === "every") {
		const ms = job.value;
		const unit = ms >= 3_600_000 ? `${ms / 3_600_000}h` : ms >= 60_000 ? `${ms / 60_000}m` : `${ms / 1000}s`;
		return `every ${unit}`;
	}
	const hours = Math.floor(job.value / 60);
	const minutes = job.value % 60;
	return `at ${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export default function (pi: ExtensionAPI) {
	// Session-scoped timers, keyed by job id. Never started in the factory.
	const timers = new Map<number, ReturnType<typeof setInterval>>();
	const timeouts = new Map<number, ReturnType<typeof setTimeout>[]>();
	let current: Job[] = [];

	const clearAll = () => {
		for (const handle of timers.values()) clearInterval(handle);
		for (const handles of timeouts.values()) for (const handle of handles) clearTimeout(handle);
		timers.clear();
		timeouts.clear();
	};

	const fire = (job: Job) => {
		// deliverAs keeps this from interrupting an in-flight turn.
		pi.sendUserMessage(`[cron ${job.id} · ${describe(job)}] ${job.prompt}`, {
			deliverAs: "followUp",
		});
	};

	const start = (job: Job) => {
		if (job.kind === "every") {
			timers.set(
				job.id,
				setInterval(() => fire(job), job.value),
			);
			return;
		}
		// "at HH:MM": one timeout to the next occurrence, then re-arm daily.
		const handles: ReturnType<typeof setTimeout>[] = [];
		const arm = () => {
			const now = new Date();
			const next = new Date(now);
			next.setHours(Math.floor(job.value / 60), job.value % 60, 0, 0);
			if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
			handles.push(
				setTimeout(() => {
					fire(job);
					arm();
				}, next.getTime() - now.getTime()),
			);
		};
		arm();
		timeouts.set(job.id, handles);
	};

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager?.getEntries?.() ?? [];
		current = readState(entries).jobs;
		clearAll();
		for (const job of current) start(job);
		if (current.length > 0) {
			ctx.ui.setStatus("cron", `cron: ${current.length} job${current.length > 1 ? "s" : ""}`);
		}
	});

	pi.on("session_shutdown", async () => {
		clearAll();
		current = [];
	});

	pi.registerCommand("cron", {
		description: "Schedule a prompt into this session: add / list / remove",
		getArgumentCompletions: (prefix) => {
			const first = (prefix ?? "").trim().split(/\s+/)[0] ?? "";
			if (first !== "" && (prefix ?? "").includes(" ")) return null;
			return ["add", "list", "remove"]
				.filter((v) => v.startsWith(first))
				.map((v) => ({ value: v, label: v }));
		},
		handler: async (args, ctx) => {
			const raw = (args ?? "").trim();
			const entries = ctx.sessionManager?.getEntries?.() ?? [];
			const state = readState(entries);
			const [verb, ...rest] = raw.split(/\s+/);

			if (!verb || verb === "list") {
				if (state.jobs.length === 0) {
					ctx.ui.notify("No cron jobs.", "info");
					return;
				}
				const lines = state.jobs.map((job) => `  ${job.id}. ${describe(job)} → ${job.prompt}`);
				ctx.ui.notify(`cron jobs:\n${lines.join("\n")}`, "info");
				return;
			}

			if (verb === "remove") {
				const id = Number(rest[0]);
				if (!Number.isInteger(id)) {
					ctx.ui.notify("Usage: /cron remove <id>", "error");
					return;
				}
				const jobs = state.jobs.filter((job) => job.id !== id);
				if (jobs.length === state.jobs.length) {
					ctx.ui.notify(`No job ${id}.`, "error");
					return;
				}
				pi.appendEntry(CUSTOM_TYPE, { jobs, nextId: state.nextId });
				const handle = timers.get(id);
				if (handle) clearInterval(handle);
				for (const h of timeouts.get(id) ?? []) clearTimeout(h);
				timers.delete(id);
				timeouts.delete(id);
				ctx.ui.notify(`removed cron job ${id}`, "info");
				return;
			}

			if (verb === "add") {
				// /cron add every 10m <prompt>   |   /cron add at 09:30 <prompt>
				const mode = rest[0];
				const when = rest[1];
				const prompt = rest.slice(2).join(" ").trim();
				if (!mode || !when || !prompt) {
					ctx.ui.notify(
						"Usage:\n  /cron add every 10m <prompt>\n  /cron add at 09:30 <prompt>",
						"error",
					);
					return;
				}
				let value: number | null = null;
				let kind: Job["kind"];
				if (mode === "every") {
					value = parseDuration(when);
					kind = "every";
					if (value !== null && value < 10_000) {
						ctx.ui.notify("Minimum interval is 10s.", "error");
						return;
					}
				} else if (mode === "at") {
					value = parseTimeOfDay(when);
					kind = "at";
				} else {
					ctx.ui.notify(`Unknown mode "${mode}". Use "every <10m>" or "at <HH:MM>".`, "error");
					return;
				}
				if (value === null) {
					ctx.ui.notify(`Could not parse "${when}".`, "error");
					return;
				}
				const job: Job = {
					id: state.nextId,
					kind,
					value,
					prompt,
					createdAt: new Date().toISOString(),
				};
				const jobs = [...state.jobs, job];
				pi.appendEntry(CUSTOM_TYPE, { jobs, nextId: state.nextId + 1 });
				start(job);
				ctx.ui.setStatus("cron", `cron: ${jobs.length} job${jobs.length > 1 ? "s" : ""}`);
				ctx.ui.notify(`cron ${job.id} added: ${describe(job)} → ${prompt}`, "info");
				return;
			}

			ctx.ui.notify(`Unknown subcommand "${verb}". Use add / list / remove.`, "error");
		},
	});
}
