#!/bin/bash
# install.sh — copy pomulum.ts + SKILL.md into an agent's skill folder.
#
#   bash install.sh                      # -> $POMULUM_SKILL_DIR, or ~/.zcode/skills/pomulum
#   bash install.sh --all                # every known host folder that exists
#   bash install.sh DIR [DIR ...]        # install into each skill folder given
#   POMULUM_SKILL_DIR=~/.claude/skills/pomulum bash install.sh
#
# --all looks for the folders of the hosts in use: ZCode (~/.zcode/skills),
# the cross-agent convention (~/.agents/skills) and Claude Code
# (~/.claude/skills). One command keeps every host on the same copy — two
# installs that drift apart are two sources of truth.
#
# The skill keeps a COPY, not a symlink: run this again after every change to
# pomulum.ts.
set -eu
cd "$(dirname "$0")/../.."

install_to() {
  local dest="$1"
  mkdir -p "$dest"
  cp pomulum.ts "$dest/pomulum.ts"
  cp skills/pomulum/SKILL.md "$dest/SKILL.md"
  # The installed folder sits OUTSIDE the repo, so it needs its own module
  # marker: without it Node guesses the module type of the copied .ts file and
  # prints MODULE_TYPELESS_PACKAGE_JSON on stderr for every command — noise
  # that an agent reading JSON can mistake for an error.
  printf '{\n  "type": "module",\n  "private": true\n}\n' > "$dest/package.json"
  echo "installed → $dest"
  node "$dest/pomulum.ts" --version # proves the copy runs and needs no repo
}

HOSTS="$HOME/.zcode/skills $HOME/.agents/skills $HOME/.claude/skills"

if [ "${1:-}" = "--all" ]; then
  installed=0
  for root in $HOSTS; do
    [ -d "$root" ] || continue
    install_to "$root/pomulum"
    installed=$((installed + 1))
  done
  if [ "$installed" -eq 0 ]; then
    echo "no known agent skill folder found. Looked for:" >&2
    for root in $HOSTS; do echo "  $root" >&2; done
    echo "Create one, or pass the folder: bash install.sh DIR" >&2
    exit 1
  fi
  echo "$installed host(s) updated"
elif [ "$#" -gt 0 ]; then
  for dest in "$@"; do
    install_to "$dest"
  done
else
  install_to "${POMULUM_SKILL_DIR:-$HOME/.zcode/skills/pomulum}"
fi
