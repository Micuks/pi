/**
 * Side conversation — `/side <question>`
 *
 * Codex-style `/side`: ask a question about the current session WITHOUT
 * derailing the main thread. The side turn runs in a separate `pi` process with
 * its own context window, seeded from a serialized copy of this session, and
 * its answer is shown as a transient message rather than appended as a normal
 * assistant turn.
 *
 * Why a subprocess: the main session's transcript must stay untouched. Running
 * the question in-process would append a user/assistant pair that the model
 * then has to reason around for the rest of the session.
 *
 * Usage:
 *   /side what does the probe record at the exit boundary?
 *   /side --no-context explain what expandable_segments does
 *
 * `/btw` is an alias for the same command. It is registered separately because
 * pi has no alias mechanism, and it exists because "by the way" is the phrasing
 * that tends to precede exactly this kind of side question.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

/** Cap the transcript we hand to the side process; keeps the seed prompt bounded. */
const MAX_TRANSCRIPT_CHARS = 60_000;

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && fs.existsSync(currentScript) && !currentScript.startsWith("/$bunfs/root/")) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

/**
 * Serialize the session for the side process.
 *
 * `serializeConversation` needs LLM-shaped messages, so the raw session entries
 * go through `convertToLlm` first. The tail is kept rather than the head: the
 * recent turns are what a follow-up question is normally about.
 */
function buildTranscript(ctx: ExtensionCommandContext): string {
	try {
		const entries = ctx.sessionManager?.getEntries?.() ?? [];
		const messages = [];
		for (const entry of entries) {
			if (entry.type !== "message") continue;
			messages.push(entry.message);
		}
		if (messages.length === 0) return "";
		let text = serializeConversation(convertToLlm(messages));
		if (text.length > MAX_TRANSCRIPT_CHARS) {
			text = `[...earlier turns omitted...]\n${text.slice(-MAX_TRANSCRIPT_CHARS)}`;
		}
		return text;
	} catch {
		return "";
	}
}

/**
 * Build the command handler for one invocation name.
 *
 * The name is captured rather than hardcoded so the usage hint and the result
 * prefix match what the user actually typed: `/btw` should not answer with
 * "side: ...".
 */
function makeHandler(invocation: string) {
	return async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		let question = (args ?? "").trim();
		let useContext = true;
		if (question.startsWith("--no-context")) {
			useContext = false;
			question = question.slice("--no-context".length).trim();
		}
		if (!question) {
			ctx.ui.notify(`Usage: /${invocation} [--no-context] <question>`, "error");
			return;
		}

		const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		const spawnArgs = ["--mode", "json", "-p", "--no-session"];
		if (model) spawnArgs.push("--model", model);
		if (ctx.thinkingLevel) spawnArgs.push("--thinking", ctx.thinkingLevel);

		let prompt = question;
		if (useContext) {
			const transcript = buildTranscript(ctx);
			if (transcript) {
				prompt = [
					"Below is a transcript of an ongoing coding session. Answer the",
					"question about it. Be concise and specific; cite file paths and",
					"line numbers when the transcript contains them. If the transcript",
					"does not contain the answer, say so plainly instead of guessing.",
					"",
					"<transcript>",
					transcript,
					"</transcript>",
					"",
					`Question: ${question}`,
				].join("\n");
			}
		}

		spawnArgs.push(prompt);

		const answer = await new Promise<string>((resolve) => {
			let stdout = "";
			let stderr = "";
			let failure = "";
			let settled = false;
			// Named to avoid shadowing the `invocation` parameter (the command
			// name), which the messages below interpolate.
			const piInvocation = getPiInvocation(spawnArgs);
			const proc = spawn(piInvocation.command, piInvocation.args, {
				cwd: ctx.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			const finish = (value: string) => {
				if (settled) return;
				settled = true;
				resolve(value);
			};
			proc.stdout.on("data", (chunk) => {
				stdout += String(chunk);
			});
			proc.stderr.on("data", (chunk) => {
				stderr += String(chunk);
			});
			proc.on("error", (err) => finish(`${invocation} failed to start: ${err.message}`));
			proc.on("close", (code) => {
				// JSON mode emits one event per line; collect the finalized
				// assistant text rather than the raw stream.
				const texts = [];
				for (const line of stdout.split("\n")) {
					if (!line.trim()) continue;
					try {
						const event = JSON.parse(line);
						if (event.type === "message_end" && event.message?.role === "assistant") {
							const message = event.message;
							for (const part of message.content ?? []) {
								if (part.type === "text" && part.text) texts.push(part.text);
							}
							// A refused or errored turn ends with empty content plus an
							// errorMessage; surface that instead of a blank answer.
							if (message.errorMessage && !failure) {
								const where = message.provider && message.model
									? ` (${message.provider}/${message.model})`
									: "";
								failure = `${message.errorMessage}${where}`;
							} else if (message.stopReason === "error" && !failure) {
								failure = `stopReason=error${message.rawStopReason ? `/${message.rawStopReason}` : ""}`;
							}
						}
					} catch {
						// Non-JSON noise is ignored.
					}
				}
				if (texts.length > 0) return finish(texts.join("\n\n").trim());
				// No assistant text. Report why the model produced none rather than
				// dumping stdout: in JSON mode stdout is the entire event stream
				// (hundreds of KB on a long transcript), not an answer.
				if (failure) return finish(`${invocation} failed: ${failure}`);
				if (code !== 0) {
					return finish(`${invocation} exited ${code}: ${stderr.trim().slice(0, 400) || "no output"}`);
				}
				finish(`${invocation} returned no text${stderr.trim() ? `: ${stderr.trim().slice(0, 400)}` : ""}`);
			});
		});

		// Transient display only: nothing is appended to the main transcript.
		ctx.ui.notify(`${invocation}: ${answer}`, "info");
	};
}

export default function (pi: ExtensionAPI) {
	const description = "Ask a question about this session without derailing the main thread";
	pi.registerCommand("side", {
		description,
		getArgumentCompletions: () => null,
		handler: makeHandler("side"),
	});
	pi.registerCommand("btw", {
		// "by the way" is what people actually type before this kind of question.
		description: `${description} (alias of /side)`,
		getArgumentCompletions: () => null,
		handler: makeHandler("btw"),
	});
}
