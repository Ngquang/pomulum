#!/bin/bash
# check.sh — the deterministic quality gate for pomulum.
#
# Every rule that can be checked runs here. The rule list lives in
# docs/STANDARDS.md, and each automated rule names this script as its
# enforcement home. Exit 0 = all gates pass.
#
#   bash scripts/check.sh
#
# No dependencies beyond bash, node, and grep. It never touches the screen,
# so it runs in CI and on any platform.
set -u
cd "$(dirname "$0")/.."

PASS=0
FAIL=0
UNIT_LOG=/tmp/pomulum-check-unit.log

ok()  { echo "  ✓ $1"; PASS=$((PASS + 1)); }
bad() { echo "  ✗ $1"; FAIL=$((FAIL + 1)); }

# Fail the whole script when a non-zero exit is produced inside a check.
json_ok() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{JSON.parse(s)})' 2>/dev/null; }

echo "== pomulum check =="

# V1 — the pure logic is tested headless.
if node --test pomulum.test.ts >"$UNIT_LOG" 2>&1; then
  ok "unit tests pass"
else
  bad "unit tests fail (see $UNIT_LOG)"
fi

# V2 — the file runs on this Node. This also proves erasable-types-only
# syntax: an enum or namespace would abort the parse here.
if node pomulum.ts --help >/dev/null 2>&1; then
  ok "runs directly (erasable types only)"
else
  bad "pomulum.ts does not run — non-erasable syntax or a syntax error?"
fi

# V3 — the JSON contract holds on success and on failure.
if node pomulum.ts status --json 2>/dev/null | json_ok; then
  ok "status --json is parseable JSON"
else
  bad "status --json is not parseable JSON"
fi
ERR=$(node pomulum.ts record --json --definitely-unknown 2>&1 >/dev/null)
RC=$?
if [ "$RC" = "2" ] && echo "$ERR" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(j.class!=="usage"||!j.error)process.exit(1)})' 2>/dev/null; then
  ok "argument errors are JSON with exit 2"
else
  bad "argument error contract broken (exit $RC)"
fi

# V4 — one version, one source of truth: the code, the package manifest, and
# what the CLI answers when a user (or a script) asks for the version.
V_TS=$(grep -oE 'const VERSION = "[^"]+"' pomulum.ts | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
V_PKG=$(node -e 'console.log(require("./package.json").version)')
V_CLI=$(node pomulum.ts --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
if [ "$V_TS" = "$V_PKG" ] && [ "$V_TS" = "$V_CLI" ]; then
  ok "version consistent in code, package.json and --version ($V_TS)"
else
  bad "version drift: code=$V_TS package.json=$V_PKG --version=$V_CLI"
fi

# S1 — research/product separation: the published tree must not reference the
# private workspace or a user home path. This checker and the standards file
# quote the patterns, so both are excluded from the scan.
LEAK=$(grep -rnE '(/Users/|Desktop/workspace|research/)' \
  --include='*.ts' --include='*.md' --include='*.sh' --include='*.json' --include='*.mjs' . \
  | grep -v '^\./scripts/check.sh' | grep -v '^\./docs/STANDARDS.md')
if [ -z "$LEAK" ]; then
  ok "no internal paths or research references"
else
  bad "internal path or research reference in shipped files:"
  echo "$LEAK" | sed 's/^/      /'
fi

# S2 — runtime files in a world-writable directory are created safely
# (O_EXCL, mode 0600, never following a leftover symlink).
if grep -nE 'openSync\([^)]*,\s*"w"' pomulum.ts >/dev/null; then
  bad 'bare openSync(path, "w") follows symlinks — use createRuntimeFile'
else
  ok "runtime files use the safe create helper"
fi

# S3 — process identity and signals never depend on PATH or a bare pid.
if grep -nE 'spawnSync\("ps"' pomulum.ts >/dev/null; then
  bad 'ps resolved through PATH — use /bin/ps'
else
  ok "process identity uses an absolute ps path"
fi
if grep -nE 'shell:\s*true' pomulum.ts >/dev/null; then
  bad "shell: true found — spawns must use argv arrays"
else
  ok "no shell interpolation in spawns"
fi

# D1 — the CLI and its own help text cannot drift apart.
MISSING=""
for c in screens snap record status stop; do
  grep -q "pomulum $c " pomulum.ts || MISSING="$MISSING $c"
done
if [ -z "$MISSING" ]; then
  ok "help text documents all five commands"
else
  bad "help text misses:$MISSING"
fi

# D2 — the Screen Recording remedy never points at ffmpeg. macOS attributes
# the grant (TCC) to the app that launches the capture; one shipped message
# told the user to check "the Screen Recording permission of ffmpeg", which
# sends them to an entry that does not exist. This checker and the standards
# file quote the wrong phrasing, so both are excluded from the scan.
WRONG_ADVICE=$(grep -rnE 'permission of ffmpeg|(enable|allow|grant|toggle)[^.\n]{0,20}ffmpeg|ffmpeg[^.\n]{0,20}Screen Recording' \
  --include='*.ts' --include='*.md' --include='*.sh' . \
  | grep -v '^\./scripts/check.sh' | grep -v '^\./docs/STANDARDS.md')
if [ -z "$WRONG_ADVICE" ]; then
  ok "the TCC remedy never blames ffmpeg"
else
  bad "a message tells the user to grant Screen Recording to ffmpeg:"
  echo "$WRONG_ADVICE" | sed 's/^/      /'
fi

# D8 — no dangling references. A deleted file must not survive in the docs:
# removing the logo generator once left README.md pointing at it.
BROKEN=""
for f in README.md CHANGELOG.md docs/*.md skills/pomulum/SKILL.md; do
  [ -f "$f" ] || continue
  d=$(dirname "$f")
  refs=$(grep -oE '\]\([^)#][^)]*\)|src="[^"]+"' "$f" \
    | sed -E 's/^\]\(//; s/\)$//; s/^src="//; s/"$//' \
    | grep -vE '^(https?:|mailto:|#)')
  for l in $refs; do
    [ -e "$d/$l" ] || BROKEN="$BROKEN
      $f -> $l"
  done
done
if [ -z "$BROKEN" ]; then
  ok "every relative doc reference resolves"
else
  bad "dangling doc reference(s):$BROKEN"
fi

echo "──── $PASS pass · $FAIL fail ────"
[ "$FAIL" -eq 0 ]
