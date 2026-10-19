#!/usr/bin/env bash
# Install the pi-extras resources into a Pi agent directory.
#
# The extras live at <repo>/pi-extras and are consumed two ways:
#   1. As a Pi package (`pi install git:github.com/Micuks/pi`) for people who want
#      Pi to manage the checkout and update it with `pi update`.
#   2. Through this script, which symlinks the resources into an existing agent
#      directory. Symlinks (not copies) so `git pull` in the checkout is enough
#      to pick up changes — no reinstall, no drift between two copies.
#
# Usage:
#   ./install.sh                 # install into ${PI_CODING_AGENT_DIR:-~/.pi/agent}
#   ./install.sh --dir /path     # install into a specific agent directory
#   ./install.sh --copy          # copy instead of symlink
#   ./install.sh --uninstall     # remove only the entries this script created
#   ./install.sh --dry-run       # print the plan, change nothing
set -euo pipefail

EXTRAS_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
AGENT_DIR=${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}
MODE=symlink
DRY_RUN=0
UNINSTALL=0

while [ $# -gt 0 ]; do
    case "$1" in
        --dir) AGENT_DIR=$2; shift 2 ;;
        --copy) MODE=copy; shift ;;
        --uninstall) UNINSTALL=1; shift ;;
        --dry-run) DRY_RUN=1; shift ;;
        -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

# Each installed resource directory gets a manifest listing exactly the names we
# created. --uninstall reads it, so it never deletes a file the user put there.
MANIFEST=".pi-extras-installed"

run() {
    if [ "$DRY_RUN" = 1 ]; then
        echo "  would: $*"
    else
        "$@"
    fi
}

install_one() {
    local src=$1 dst=$2
    if [ "$MODE" = copy ]; then
        run cp -f "$src" "$dst"
    else
        run ln -sfn "$src" "$dst"
    fi
}

# Resource files, excluding README.md and other prose that must not be loaded as
# an agent definition or prompt template.
resource_files() {
    local dir=$1 pattern=$2
    [ -d "$dir" ] || return 0
    find "$dir" -maxdepth 1 -type f -name "$pattern" ! -name 'README.md' | sort
}

if [ "$UNINSTALL" = 1 ]; then
    echo "Removing pi-extras from ${AGENT_DIR}"
    for kind in extensions agents prompts; do
        target="${AGENT_DIR}/${kind}"
        [ -f "${target}/${MANIFEST}" ] || continue
        while IFS= read -r name; do
            [ -n "$name" ] || continue
            path="${target}/${name}"
            if [ -L "$path" ]; then
                dest=$(readlink "$path")
                case "$dest" in
                    "${EXTRAS_DIR}"/*) run rm -f "$path" ;;
                    *) echo "  skip ${path}: link points elsewhere (${dest})" ;;
                esac
            elif [ -e "$path" ]; then
                # Copied install: the manifest is the only evidence of ownership,
                # so removing it is correct here.
                run rm -f "$path"
            fi
        done < "${target}/${MANIFEST}"
        run rm -f "${target}/${MANIFEST}"
    done
    echo "Done. Directories themselves are left in place."
    exit 0
fi

if [ ! -d "$AGENT_DIR" ]; then
    echo "agent directory does not exist: ${AGENT_DIR}" >&2
    echo "Start pi once, or pass --dir, or set PI_CODING_AGENT_DIR." >&2
    exit 1
fi

echo "Installing pi-extras from ${EXTRAS_DIR} into ${AGENT_DIR} (mode: ${MODE})"

# extensions: top-level .ts files, plus the subagent directory which needs its
# index.ts and agents.ts to stay siblings.
mkdir -p "${AGENT_DIR}/extensions"
: > "${AGENT_DIR}/extensions/${MANIFEST}.tmp"
while IFS= read -r src; do
    name=$(basename "$src")
    install_one "$src" "${AGENT_DIR}/extensions/${name}"
    printf '%s\n' "$name" >> "${AGENT_DIR}/extensions/${MANIFEST}.tmp"
done < <(resource_files "${EXTRAS_DIR}/extensions" '*.ts')
if [ -d "${EXTRAS_DIR}/extensions/subagent" ]; then
    install_one "${EXTRAS_DIR}/extensions/subagent" "${AGENT_DIR}/extensions/subagent"
    printf '%s\n' subagent >> "${AGENT_DIR}/extensions/${MANIFEST}.tmp"
fi

mkdir -p "${AGENT_DIR}/agents"
: > "${AGENT_DIR}/agents/${MANIFEST}.tmp"
while IFS= read -r src; do
    name=$(basename "$src")
    install_one "$src" "${AGENT_DIR}/agents/${name}"
    printf '%s\n' "$name" >> "${AGENT_DIR}/agents/${MANIFEST}.tmp"
done < <(resource_files "${EXTRAS_DIR}/agents" '*.md')

mkdir -p "${AGENT_DIR}/prompts"
: > "${AGENT_DIR}/prompts/${MANIFEST}.tmp"
while IFS= read -r src; do
    name=$(basename "$src")
    install_one "$src" "${AGENT_DIR}/prompts/${name}"
    printf '%s\n' "$name" >> "${AGENT_DIR}/prompts/${MANIFEST}.tmp"
done < <(resource_files "${EXTRAS_DIR}/prompts" '*.md')

if [ "$DRY_RUN" = 0 ]; then
    for kind in extensions agents prompts; do
        mv "${AGENT_DIR}/${kind}/${MANIFEST}.tmp" "${AGENT_DIR}/${kind}/${MANIFEST}"
    done
else
    rm -f "${AGENT_DIR}"/*/"${MANIFEST}.tmp"
fi

cat <<EOF

Installed. Restart pi (or run /reload) to pick up the new resources.

Slash commands:
  /side <question>        ask about this session without derailing it
  /goal <objective>       standing objective, re-injected every run
  /cron add every 10m …   schedule a prompt into this session
  /loop [10m] <prompt>    re-submit a prompt, fixed or self-paced

Subagent workflows: /implement, /scout-and-plan, /implement-and-review
EOF
