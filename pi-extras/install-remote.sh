#!/usr/bin/env bash
# One-shot installer for pi-extras.
#
# Clones Micuks/pi sparsely (only pi-extras/ is materialized), then installs the
# resources into the Pi agent directory with pi-extras/install.sh.
#
# Why not `pi install git:github.com/Micuks/pi`?
#   Pi's git installer always clones the repository ROOT and then runs
#   `npm install` there when a package.json exists. This fork is a copy of the
#   upstream monorepo, whose root package.json has `"prepare": "husky"`, and
#   husky is a devDependency that `--omit=dev` does not install. npm therefore
#   exits 127 and Pi deletes the checkout. A sparse checkout of just pi-extras/
#   has no package.json at its root, so that failure mode cannot occur.
#
# Usage:
#   curl -fsSL …/install-remote.sh | bash
#   ./install-remote.sh                 # clone into ~/.pi/pi-extras-src
#   ./install-remote.sh --src DIR       # clone location
#   ./install-remote.sh --ref main      # branch/tag/commit (default: main)
#   ./install-remote.sh --update        # update an existing checkout, then install
#   ./install-remote.sh --dry-run
set -euo pipefail

REPO_URL=${PI_EXTRAS_REPO:-https://github.com/Micuks/pi.git}
REF=main
SRC=${PI_EXTRAS_SRC:-$HOME/.pi/pi-extras-src}
DRY_RUN=0
UPDATE_ONLY=0

while [ $# -gt 0 ]; do
    case "$1" in
        --src) SRC=$2; shift 2 ;;
        --ref) REF=$2; shift 2 ;;
        --update) UPDATE_ONLY=1; shift ;;
        --dry-run) DRY_RUN=1; shift ;;
        -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

run() {
    if [ "$DRY_RUN" = 1 ]; then echo "  would: $*"; else "$@"; fi
}

need() {
    command -v "$1" >/dev/null 2>&1 || { echo "missing dependency: $1" >&2; exit 1; }
}
need git

if [ -d "$SRC/.git" ]; then
    echo "Updating existing checkout at ${SRC}"
    run git -C "$SRC" fetch --depth 1 origin "$REF"
    run git -C "$SRC" checkout -q FETCH_HEAD
elif [ "$UPDATE_ONLY" = 1 ]; then
    echo "no checkout at ${SRC}; nothing to update" >&2
    exit 1
else
    echo "Cloning ${REPO_URL} (sparse: pi-extras only) into ${SRC}"
    run git clone --depth 1 --filter=blob:none --sparse --branch "$REF" "$REPO_URL" "$SRC"
    run git -C "$SRC" sparse-checkout set pi-extras
fi

INSTALL_SH="${SRC}/pi-extras/install.sh"
if [ ! -f "$INSTALL_SH" ]; then
    echo "expected ${INSTALL_SH} to exist after checkout" >&2
    exit 1
fi
chmod +x "$INSTALL_SH"

# `set -u` makes "${arr[@]}" on an empty array an unbound-variable error on older
# bash (macOS ships 3.2). Build the argument list explicitly instead.
if [ "$DRY_RUN" = 1 ]; then
    run bash "$INSTALL_SH" --dry-run
else
    run bash "$INSTALL_SH"
fi
