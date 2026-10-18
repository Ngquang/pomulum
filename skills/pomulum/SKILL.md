---
name: pomulum
description: >
  Record or capture the macOS screen with a CLI — made for agents, no GUI
  needed. Trigger phrases (the user speaks Vietnamese): "quay màn hình",
  "chụp màn hình", "record màn hình", "record vùng này" — and the English
  equivalents "screen recording", "record a demo/bug/flow".
  The agent reads a snapshot with vision to select the crop coordinates,
  then records and stops. JSON contract; verification with ffprobe.
---

# pomulum — agent screen recorder

One-file CLI (TypeScript, runs on Node >= 22.18, ffmpeg engine). pomulum needs
no Screen Recording permission of its own: macOS attributes the grant (TCC)
to the app that launches the capture — your terminal or agent host.

Tool: set `POMULUM` to the absolute path of `pomulum.ts` and run
`node $POMULUM <command>`. In a repo clone that is `<repo>/pomulum.ts`.
The INSTALLED skill folder holds a copy of `pomulum.ts` next to this
file (the source of truth is the repo file; after it changes, run
`bash install.sh` in the repo to refresh the copy).

## What this skill touches (capability declaration)

Audit this list before you install. The skill runs one CLI; it has no
network access, no telemetry, and no package dependencies.

| Capability | Detail |
|---|---|
| Runs | `node pomulum.ts`, which spawns `ffmpeg`, `ffprobe`, `/usr/bin/caffeinate -i` (macOS), and `/bin/ps`. All spawns use argument arrays — no shell. |
| Writes | The recording (`--out`, default `~/Desktop/pomulum-<time>.mp4`); the pidfile `/tmp/pomulum-rec.pid` and the log `/tmp/pomulum-ffmpeg.log`, both mode 0600, created exclusively, never following a symlink; a snapshot PNG in the private per-user temp directory unless `--out` is given; the device-dimension cache `~/Library/Caches/pomulum/screen-cache.json`. |
| Reads | Its own JSON output, the pidfile, the ffmpeg log, the snapshot PNG (the agent views it), and `ps` output to confirm process identity. |
| Permissions | Screen Recording for the HOST APP (it captures the screen); Microphone when audio is on (on by default). No other permission is requested. |
| Signals | SIGINT, then SIGTERM, then SIGKILL — and only to the process group of a recording it can positively identify. It never signals another process. |
| Deletes | Only its own pidfile and its own temporary probe files. |
| Installs | `install.sh` copies two files (`pomulum.ts`, `SKILL.md`) into the skill folder and writes a minimal `package.json` module marker next to them. `--all` does that for every known agent host folder; each destination can also be passed as an argument. |

## Standard flow for an agent

```bash
node $POMULUM screens --json                    # 1. list screens + mics (real pixel dimensions, cached)
node $POMULUM snap --screen N --out /tmp/s.png  # 2. capture one frame at native resolution of screen N
# 3. the agent Reads the PNG (vision) and selects an area in image PIXELS.
#    Image coordinates equal crop coordinates 1:1 — there is NO coordinate
#    conversion step.
node $POMULUM record --screen N --crop x:y:w:h --duration 60 --json
node $POMULUM status --json                     # is a recording in progress — what, where, how long
node $POMULUM stop --json                       # ALWAYS the last step: stop, verify with ffprobe,
                                                # and clean the pidfile — also right after a
                                                # --duration recording that ended by itself
```

## Commands and main flags

- `screens [--json] [--no-cache]` — avfoundation screens + mics, real dimensions
- `snap [--out F] [--screen N]` — one native-resolution PNG (about 0.7 s)
- `record [--crop x:y:w:h] [--screen N] [--duration N] [--max-duration N]
  [--out F] [--no-mic] [--half] [--full-res] [--small] [--dry-run] [--json]`
  — detached (the prompt returns immediately); the microphone is ON by
  default (the system default mic, index 0 — v0 has no mic picker); a
  safety limit of 30 minutes applies when you do not set `--duration`
  (`--max-duration 0` removes the limit)
- `status [--json]` — always exits with 0
- `stop [--json]` — SIGINT, then verification with ffprobe (the exit code of
  ffmpeg is not trusted), then escalation to SIGTERM and SIGKILL.
  `wallSeconds` is the wall-clock time from `record` to `stop` — for the
  media length read `verified.durationSeconds`: a stop lands on a frame
  boundary (about one frame short of `--duration`), and a busy machine can
  drop frames, so the verified length is the truth, not the flag.
- `--version`, `-v`, `version` — print the version; `help` works like
  `--help`

**Output size — read before verifying:** the recording keeps the crop
dimensions at native resolution by default (`--crop 800:500` saves an
**800×500** file). Pass `--half` for a half-size file (400×250 — about 55%
smaller, softer small text), or `--small` for CRF 28 + half scale (smallest).
`--full-res` still forces full resolution — overriding the half scale of
`--half`/`--small` — which is the default anyway; kept so pre-0.2.0
commands keep working.
Verify file dimensions against the `expectedDims` field of the `record`
JSON, not against the crop — that field is exact (each axis is floored to an
even size, which the encoder requires).

**Crop coordinates are not guessed.** A `--crop` that does not fit the
selected screen exits **2** with the real screen size and the largest area at
that origin; it is never shrunk silently. Take the numbers from a `snap` of
the same screen. A crop that fits only partly comes back as `requestedCrop`
plus the applied `crop` with `cropClamped: true` — check that flag.

## Contract

- `--json` for every command; exit 0 = OK, 1 = runtime error, 2 = argument error
- Default output file: `~/Desktop/pomulum-<timestamp>.mp4`
- Pidfile `/tmp/pomulum-rec.pid`; ffmpeg log `/tmp/pomulum-ffmpeg.log`
- One recording at a time. `record` during a recording exits with 1.

## Frequent problems

- `--crop` uses the PIXELS of the capture frame of the selected screen
  (origin = top left of THAT screen). Take the values directly from a snap
  made with the same `--screen N`.
- The device list changes when the user connects or disconnects a display.
  Always read `screens` fresh. Do not make an index permanent. (`--screen 99`
  exits with 2 and prints the valid list.)
- `--screen N` is the raw avfoundation DEVICE INDEX printed by `screens` —
  not the ordinal in the name (`Capture screen 1` can have device index 4).
  To record the screen NAMED "Capture screen 1", pass the index shown next
  to that name.
- When `screens` returns 0 screens, or a capture hangs: the Screen
  Recording permission (TCC) of the HOST APP was lost. Ask the user to open
  System Settings → Privacy & Security → Screen Recording and toggle the
  entry of the app that runs you (ZCode, DeepSeek Harness, Terminal — not
  `ffmpeg`; that entry exists only when ffmpeg runs without an app wrapper)
  OFF and ON. On macOS 27 this grant often disappears after the user
  connects or disconnects an external display (seen twice in 10/2026).
  Check whether the display setup just changed.
- Verify a recording with the JSON output of `stop` (ffprobe data). Do not
  conclude from an exit code.
