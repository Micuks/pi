# pi-extras

Codex- and Claude-Code-style workflows for [pi](https://pi.dev), packaged so they
can be installed in one command and kept up to date with upstream.

Pi deliberately ships without subagents, plan mode, or cron-style scheduling:
*"Pi ships with powerful defaults but skips features like sub-agents and plan
mode. Ask Pi to build what you want."* This directory is that build — a small,
readable set of extensions that add the handful of workflow primitives people
most often miss, plus a fix for the subagent example's model pinning.

Nothing here patches pi itself. Every extension uses the documented extension
API, so upstream changes that keep the API stable do not affect these files.

---

## What you get

| Command | What it does | Source |
|---|---|---|
| `/side <question>` | Ask about the current session **without derailing it** — runs in a separate `pi` process seeded from the transcript, answer shown as a transient message. | `extensions/side.ts` |
| `/goal <objective>` | A standing objective stored as a session entry and re-injected into every run, so it survives compaction. | `extensions/goal.ts` |
| `/cron add every 10m …` | Schedule a prompt into this session on an interval, or daily at `HH:MM`. | `extensions/cron.ts` |
| `/loop [10m] <prompt>` | Re-submit a prompt: fixed interval, or **self-paced** where the model signals `[loop-next: 5m]` / `[loop-done]`. Supports `--max N` and `--until <condition>`. | `extensions/loop.ts` |
| `/todos` | Todo list with state stored in session entries, so it branches correctly. | `extensions/todo.ts` (upstream example) |
| `/handoff <goal>` | Carry context into a fresh, focused session instead of lossily compacting. | `extensions/handoff.ts` (upstream example) |
| `/bookmark`, `/unbookmark` | Mark and jump between points in a session. | `extensions/bookmark.ts` (upstream example) |
| `subagent` tool | Delegate to isolated-context subagents: single, parallel (8 tasks / 4 concurrent), or chained with `{previous}`. | `extensions/subagent/` (upstream example) |

Plus the upstream subagent workflows: `/implement`, `/scout-and-plan`,
`/implement-and-review`.

### `/side` vs subagent

`/side` is one-shot and read-mostly: it answers a question about what you have
already done, and its output never becomes part of the main transcript.
The `subagent` tool is for doing work: it has its own tools, runs to completion,
and its result comes back as a tool result. Use `/side` to ask "what did that
error mean, again?" without a permanent turn; use a subagent when you want the
work actually done.

### `/loop` vs `/cron`

Both submit prompts on a schedule. `/cron` is a plain timer — it fires whether or
not the previous run mattered. `/loop` is for convergence: it can stop itself
(`--max`), and in self-paced mode it lets the model choose the next delay, so a
40-minute step does not queue up 40 overdue runs behind it. A beat is skipped,
not queued, while a run is in flight.

Markers `/loop` understands, emitted by the model in its reply:

```text
[loop-next: 5m]   run again after 5m (10s minimum)
[loop-done]       stop the loop
```

---

## Install

### One command (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/Micuks/pi/pi-extras-v1/pi-extras/install-remote.sh | bash
```

This sparse-clones only `pi-extras/` into `~/.pi/pi-extras-src` and symlinks the
resources into `~/.pi/agent`, then prints the new commands. Restart pi or run
`/reload`.

The URL pins the `pi-extras-v1` tag rather than `main`. Two reasons: a tag is
reproducible, and `raw.githubusercontent.com` caches by branch name, so a fresh
commit to `main` can serve stale bytes for a while. To track `main` deliberately:

```bash
curl -fsSL https://raw.githubusercontent.com/Micuks/pi/main/pi-extras/install-remote.sh \
  | bash -s -- --ref main
```

Already have a checkout? Update and reinstall in place:

```bash
~/.pi/pi-extras-src/pi-extras/install-remote.sh --update --ref main
```

### From a clone

```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/Micuks/pi.git
cd pi
git sparse-checkout set pi-extras
./pi-extras/install.sh
```

### Options

```bash
./install.sh --dir /path/to/agent-dir   # non-default agent directory
./install.sh --copy                     # copy files instead of symlinking
./install.sh --uninstall                # remove exactly what it installed
./install.sh --dry-run                  # print the plan, change nothing
```

`PI_CODING_AGENT_DIR` is honored for both scripts.

### Why not `pi install git:github.com/Micuks/pi`?

Pi's git installer clones the **repository root** and then runs
`npm install --omit=dev --legacy-peer-deps` there when a `package.json` exists.
This fork is a copy of the upstream monorepo, whose root `package.json` contains
`"prepare": "husky"`; `husky` is a devDependency, so `--omit=dev` leaves it
uninstalled, npm exits 127, and Pi deletes the checkout. The failure is in
upstream's monorepo layout, not in Pi:

```console
$ git clone --depth 1 https://github.com/Micuks/pi.git && cd pi
$ npm install --omit=dev --legacy-peer-deps
> pi-monorepo@0.0.3 prepare
> husky
sh: husky: command not found
npm error code 127
```

A sparse checkout of `pi-extras/` alone has no `package.json` at its root, so that
path cannot fail. That is why the installer uses `--sparse` instead of the package
manager.

---

## Updating

`pi-extras` is a fork of `earendil-works/pi` with two additions:

1. This `pi-extras/` directory (additive — no upstream file is edited).
2. A `.github/workflows/sync-upstream.yml` workflow.

The workflow runs every 6 hours and on demand. It fast-forwards when the fork has
no local commits on top of upstream, or merges upstream when it does. **A conflict
stops the job and opens an issue rather than resolving itself** — a textual
conflict in a tracking fork means upstream changed something the extras rely on,
and `-X ours` would silently discard the upstream side of that hunk.

To update by hand:

```bash
git remote add upstream https://github.com/earendil-works/pi.git   # once
git fetch upstream main
git merge upstream/main
git push origin main
```

Because `pi-extras/` is additive and the install is by symlink, updating never
requires reinstalling: `git pull` in the checkout is enough, and `/reload` picks
it up.

---

## The subagent fix

The upstream subagent example pins a model in each agent definition:

```yaml
model: claude-haiku-4-5     # examples/extensions/subagent/agents/scout.md
```

Those IDs resolve under several providers (`anthropic`, `cloudflare-ai-gateway`,
`opencode`, `radius`). Unless one of them is authenticated and selected, dispatch
fails at startup:

```text
Agent failed: Unknown agent: "worker". Available agents: none.
# or
claude-sonnet-4-5 is configured in multiple providers but none are authenticated
```

The bundled copies in `agents/` drop the `model:` line, so each subagent inherits
the dispatching session's active model and thinking level. To pin one anyway, use
an explicit provider:

```yaml
model: myflicker/claude-4.5-sonnet
```

Also note: if `pi --print` refuses with `The model refused to complete the
request`, a provider is being resolved that rejects the request — pass
`--provider <name>` explicitly.

---

## Design notes

- **Inert when unused.** Every extension returns immediately unless its command is
  invoked or its env var is set. `/cron` and `/loop` create no timer unless a job
  exists.
- **Timers are session-scoped.** Created in `session_start`, cleared in
  `session_shutdown`, never in the extension factory — pi loads extensions in
  invocations that have no session.
- **State is a session entry, not a file.** Todos, goals, cron jobs, and loop state
  are appended via `pi.appendEntry`, so branching the session restores the correct
  state at that point instead of leaking a global file's contents into a new branch.
- **`/side` never pollutes the transcript.** It spawns a subprocess and reports
  through `ctx.ui.notify`. Cost: one extra process per question.
- **`/goal` re-injects on user turns only**, so it does not stack copies of itself
  onto every internal continuation.

## Requirements

- pi 1.3.0 or newer (extension API `registerCommand`, `appendEntry`,
  `agent_settled`).
- Node 22.6+ only if you want to run the CI bundle check locally.

## License

MIT, matching upstream. Files under `extensions/` that originate from pi's
`examples/extensions/` keep their original copyright.
