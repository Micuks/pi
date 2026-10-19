#!/usr/bin/env bash
# Self-check for pi-extras. Run by the sync workflow after every upstream merge,
# and usable locally.
#
# Catches the failures that a clean git merge does NOT catch:
#   - a shell syntax error or undefined variable in the installers
#   - a TypeScript syntax error in an extension
#   - an extension that throws at load time (bad import, API rename)
#   - an agent/prompt file that pi would skip (missing frontmatter fields)
#   - an installed set that does not contain every command we advertise
#
# The last check is the important one: it installs into a throwaway agent
# directory and asks a real pi process which commands it registered, so a rename
# in upstream's extension API shows up as a failure instead of a silent gap.
set -euo pipefail

EXTRAS_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
FAIL=0

pass() { printf '  ok   %s\n' "$*"; }
fail() { printf '  FAIL %s\n' "$*"; FAIL=1; }

echo "== shell syntax =="
for f in "${EXTRAS_DIR}"/install.sh "${EXTRAS_DIR}"/install-remote.sh "${EXTRAS_DIR}"/selfcheck.sh; do
    [ -f "$f" ] || continue
    if bash -n "$f" 2>/dev/null; then pass "bash -n $(basename "$f")"; else fail "bash -n $(basename "$f")"; fi
done

echo "== shellcheck (if available) =="
if command -v shellcheck >/dev/null 2>&1; then
    for f in "${EXTRAS_DIR}"/install.sh "${EXTRAS_DIR}"/install-remote.sh; do
        # SC1091: not following sourced files. Everything else is a real finding.
        if shellcheck -S warning -e SC1091 "$f"; then pass "shellcheck $(basename "$f")"; else fail "shellcheck $(basename "$f")"; fi
    done
else
    echo "  skip shellcheck not installed"
fi

echo "== extension load =="
# Deliberately NOT `node --check`: with --experimental-strip-types node parses the
# file as CommonJS, so it reports success even for broken syntax or imports that
# do not resolve. The only trustworthy check is asking pi to load the file, which
# is also what a user does. Each extension is loaded in isolation so one bad file
# cannot mask another.
if ! command -v pi >/dev/null 2>&1; then
    echo "  skip pi not on PATH; cannot verify extensions load"
else
    # Load into an empty agent dir. Otherwise the developer's own
    # ~/.pi/agent/extensions get loaded too, and any tool-name overlap (todo,
    # subagent) looks like a failure in the file under test.
    LOAD_AGENT=$(mktemp -d)
    for f in "${EXTRAS_DIR}"/extensions/*.ts "${EXTRAS_DIR}"/extensions/subagent/index.ts; do
        [ -f "$f" ] || continue
        rel=${f#"${EXTRAS_DIR}/"}
        if out=$(PI_CODING_AGENT_DIR="$LOAD_AGENT" pi -e "$f" --mode rpc --no-session </dev/null 2>&1 \
                 | grep -m1 -iE 'error|failed to load' || true); [ -z "$out" ]; then
            pass "load $rel"
        else
            fail "load $rel: ${out:0:140}"
        fi
    done
    rm -rf "$LOAD_AGENT"
fi

echo "== agent and prompt frontmatter =="
for f in "${EXTRAS_DIR}"/agents/*.md; do
    [ -f "$f" ] || continue
    base=$(basename "$f")
    [ "$base" = "README.md" ] && continue
    if ! head -1 "$f" | grep -q '^---$'; then fail "$base: no frontmatter"; continue; fi
    if ! sed -n '2,20p' "$f" | grep -q '^name:'; then fail "$base: missing name"; continue; fi
    if ! sed -n '2,20p' "$f" | grep -q '^description:'; then fail "$base: missing description"; continue; fi
    pass "$base"
done
for f in "${EXTRAS_DIR}"/prompts/*.md; do
    [ -f "$f" ] || continue
    if head -1 "$f" | grep -q '^---$' && sed -n '2,10p' "$f" | grep -q '^description:'; then
        pass "$(basename "$f")"
    else
        fail "$(basename "$f"): needs frontmatter with description"
    fi
done

echo "== load through a real pi process =="
if ! command -v pi >/dev/null 2>&1; then
    echo "  skip pi not on PATH"
else
    TMP_AGENT=$(mktemp -d)
    # pi needs credentials even to answer get_commands; reuse the caller's when
    # present so the check works on a developer machine and in CI alike.
    for f in models.json auth.json; do
        [ -f "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/${f}" ] \
            && cp "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/${f}" "${TMP_AGENT}/"
    done
    if bash "${EXTRAS_DIR}/install.sh" --dir "$TMP_AGENT" >/dev/null 2>&1; then
        pass "install.sh into a temp agent dir"
    else
        fail "install.sh into a temp agent dir"
    fi

    WANT="side goal cron loop todos handoff bookmark implement scout-and-plan implement-and-review"
    GOT=$(PI_CODING_AGENT_DIR="$TMP_AGENT" node -e '
const { spawn } = require("node:child_process");
const proc = spawn("pi", ["--mode","rpc","--no-session"], { stdio: ["pipe","pipe","pipe"] });
let out = "";
proc.stdout.on("data", d => { out += String(d); });
proc.stdin.write(JSON.stringify({ id: "c1", type: "get_commands" }) + "\n");
setTimeout(() => {
  proc.kill();
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.command === "get_commands" && e.data && e.data.commands) {
        process.stdout.write(e.data.commands.map(c => c.name).join(" "));
        return;
      }
    } catch {}
  }
}, 6000);
' 2>/dev/null || true)

    if [ -z "${GOT// /}" ]; then
        fail "pi process returned no command list"
    else
        for w in $WANT; do
            case " $GOT " in
                *" $w "*) pass "/$w registered" ;;
                *) fail "/$w NOT registered" ;;
            esac
        done
    fi
    rm -rf "$TMP_AGENT"
fi

echo
if [ "$FAIL" = 1 ]; then
    echo "selfcheck: FAILURES above"
    exit 1
fi
echo "selfcheck: all checks passed"
