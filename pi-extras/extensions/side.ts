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

export default function (pi: ExtensionAPI) {
	pi.registerCommand("side", {
		description: "Ask a question about this session without derailing the main thread",
		getArgumentCompletions: () => null,
		handler: async (args, ctx) => {
			let question = (args ?? "").trim();
			let useContext = true;
			if (question.startsWith("--no-context")) {
				useContext = false;
				question = question.slice("--no-context".length).trim();
			}
			if (!question) {
				ctx.ui.notify("Usage: /side [--no-context] <question>", "error");
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
				let settled = false;
				const invocation = getPiInvocation(spawnArgs);
				const proc = spawn(invocation.command, invocation.args, {
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
				proc.on("error", (err) => finish(`side failed to start: ${err.message}`));
				proc.on("close", (code) => {
					// JSON mode emits one event per line; collect the finalized
					// assistant text rather than the raw stream.
					const texts = [];
					for (const line of stdout.split("\n")) {
						if (!line.trim()) continue;
						try {
							const event = JSON.parse(line);
							if (event.type === "message_end" && event.message?.role === "assistant") {
								for (const part of event.message.content ?? []) {
									if (part.type === "text" && part.text) texts.push(part.text);
								}
							}
						} catch {
							// Non-JSON noise is ignored.
						}
					}
					if (texts.length > 0) return finish(texts.join("\n\n").trim());
					if (code !== 0) return finish(`side exited ${code}: ${stderr.trim() || stdout.trim() || "no output"}`);
					finish(stdout.trim() || "(no output)");
				});
			});

			// Transient display only: nothing is appended to the main transcript.
			ctx.ui.notify(`side: ${answer}`, "info");
		},
	});
}
