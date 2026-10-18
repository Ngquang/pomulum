#!/bin/bash
# e2e-pomulum-ts.sh — headless end-to-end test for pomulum.ts (all output
# goes to /tmp, the screen of the user is not touched, and the script
# scores pass/fail by itself).
#
#   bash scripts/e2e-pomulum-ts.sh
#
# Flow: screens -> snap -> record (crop + duration 5 s) -> stop -> verify JSON.
# Requirement: the app that launches this script (terminal or agent host)
# holds the Screen Recording permission — TCC attribution follows the app.

set -u
cd "$(dirname "$0")/.."

LOG=/tmp/pomulum-e2e.log
OUT_MP4=/tmp/pomulum-e2e.mp4
OUT_PNG=/tmp/pomulum-e2e-snap.png
PASS=0; FAIL=0

log() { echo "$@" >> "$LOG"; }
ok()   { log "  ✓ $1"; PASS=$((PASS+1)); }
bad()  { log "  ✗ $1"; FAIL=$((FAIL+1)); }

# One run, one log: truncate so a RESULT line is never read next to the
# failures of an earlier run (the log used to accumulate across days).
echo "===== pomulum.ts e2e — $(date '+%Y-%m-%d %H:%M:%S') =====" > "$LOG"

# 1) screens --json
log "[1] screens --json"
S=$(node pomulum.ts screens --json 2>>"$LOG") || { bad "screens exit != 0"; exit 1; }
echo "$S" >> "$LOG"
echo "$S" | grep -q '"name": "Capture screen' && ok "capture screen present" || bad "no capture screen"

# 2) snap
log "[2] snap --out $OUT_PNG"
SN=$(node pomulum.ts snap --out "$OUT_PNG" --json 2>>"$LOG") || { bad "snap exit != 0"; exit 1; }
echo "$SN" >> "$LOG"
[ -s "$OUT_PNG" ] && ok "snap PNG exists ($(stat -f%z "$OUT_PNG") bytes)" || bad "snap PNG is empty"

# snap dimensions == screens dimensions (M3 benchmark gate)
SW=$(echo "$SN" | python3 -c 'import json,sys;print(json.load(sys.stdin)["width"])')
DW=$(echo "$S"  | python3 -c 'import json,sys;print(json.load(sys.stdin)["screens"][0]["width"])')
[ "$SW" = "$DW" ] && ok "snap dims == device dims ($SW)" || bad "dims differ: snap $SW vs device $DW"

# 3) record with a centered crop + duration 5
log "[3] record --crop 700:500:1400:700 --duration 5"
R=$(node pomulum.ts record --crop 700:500:1400:700 --duration 5 --out "$OUT_MP4" --json 2>>"$LOG") || { bad "record exit != 0"; exit 1; }
echo "$R" >> "$LOG"
echo "$R" | grep -q '"started": true' && ok "record started (pid $(echo "$R" | python3 -c 'import json,sys;print(json.load(sys.stdin)["pid"])'))" || bad "record did not start"

# 4) wait for the automatic end, then stop (idempotent for a recording that reached its duration)
sleep 7
log "[4] stop --json"
ST=$(node pomulum.ts stop --json 2>>"$LOG")
SRC=$?
echo "$ST" >> "$LOG"
if [ $SRC -eq 0 ] && echo "$ST" | grep -q '"stopped": true'; then
  ok "stop + verify artifact"
  D=$(echo "$ST" | python3 -c 'import json,sys;print(json.load(sys.stdin)["verified"]["durationSeconds"])')
  W=$(echo "$ST" | python3 -c 'import json,sys;print(json.load(sys.stdin)["verified"]["width"])')
  H=$(echo "$ST" | python3 -c 'import json,sys;print(json.load(sys.stdin)["verified"]["height"])')
  AUD=$(echo "$ST" | python3 -c 'import json,sys;print(json.load(sys.stdin)["verified"]["hasAudio"])')
  python3 -c "import sys; sys.exit(0 if 4.0 <= $D <= 6.5 else 1)" && ok "duration $D is in [4, 6.5]" || bad "duration $D is out of the band"
  [ "$W" = "1400" ] && [ "$H" = "700" ] && ok "dims crop 1400:700 at full res = ${W}×${H}" || bad "dims differ: ${W}×${H}"
  [ "$AUD" = "True" ] && ok "audio present" || bad "no audio"
else
  bad "stop exit $SRC"
fi

# 5) a second stop with no recording left must exit 1 (agent contract)
log "[5] stop when idle must exit 1"
node pomulum.ts stop --json >>"$LOG" 2>&1
[ $? -eq 1 ] && ok "idle stop exits 1 (correct contract)" || bad "idle stop exit != 1"

# 6) an incorrect flag must exit 2
log "[6] unknown flag → exit 2"
node pomulum.ts record --nonsense >>"$LOG" 2>&1
[ $? -eq 2 ] && ok "unknown flag → exit 2" || bad "unknown flag exit != 2"

# 7) --dry-run must describe the same recording the real call would make:
# real device dimensions, the applied crop, and the exact output size.
log "[7] dry-run JSON shape"
DR=$(node pomulum.ts record --dry-run --crop 100:100:1400:700 --json 2>>"$LOG")
echo "$DR" >> "$LOG"
echo "$DR" | python3 -c '
import json,sys
j=json.load(sys.stdin)
need={"requestedCrop","crop","cropClamped","expectedDims","device","dryRun"}
missing=need-set(j)
assert not missing, f"missing fields: {missing}"
assert j["dryRun"] is True and j["started"] is False
assert j["device"]["width"] and j["device"]["height"], "device dims must be real"
assert j["expectedDims"]=={"w":1400,"h":700}, j["expectedDims"]
assert j["cropClamped"] is False
' 2>>"$LOG" && ok "dry-run reports the same shape as a real record" || bad "dry-run JSON is missing fields"

# 8) a crop that does not fit is refused at the boundary (exit 2), and starts
# nothing — it used to be clamped to 2x2 and die inside the encoder.
log "[8] a crop outside the screen → exit 2"
ERR8=$(node pomulum.ts record --crop 9000:9000:100:100 --out /tmp/pomulum-e2e-never.mp4 --json 2>&1 >/dev/null)
RC8=$?
if [ $RC8 -eq 2 ] && echo "$ERR8" | grep -q '"class": "usage"'; then
  ok "crop outside the screen → exit 2 (usage)"
else
  bad "crop outside the screen exit $RC8 (want 2)"
fi
[ -e /tmp/pomulum-e2e-never.mp4 ] && bad "a refused crop wrote a file" || ok "a refused crop wrote nothing"

echo "──── RESULT: $PASS pass · $FAIL fail ────" >> "$LOG"
echo "log: $LOG"
[ $FAIL -eq 0 ]
