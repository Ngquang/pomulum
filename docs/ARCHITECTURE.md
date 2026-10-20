# Architecture: one file, one engine, one contract

## Design principle

**ffmpeg does the capture and encode work; `pomulum.ts` only controls the
process.** Capture (avfoundation) and encode (libx264) live inside ffmpeg; the
TypeScript file spawns it, watches it, and reports the result. Nothing else.

This fact shapes everything: pomulum never touches the screen itself, so
**it needs no Screen Recording permission**. macOS attributes the grant
(TCC) to the app that launches the capture chain: your terminal (Terminal,
iTerm) or the agent host (ZCode, DeepSeek Harness, ...). In System Settings →
Privacy & Security → Screen Recording you grant THAT app; an `ffmpeg` entry
appears only when ffmpeg starts without an app wrapper (ssh, launchd). Each
host app needs its own grant once, and in an app-hosted context the grant
survives both pomulum and ffmpeg updates.

## Built for an agent loop

A human uses an overlay to select the screen area. An agent cannot use an
overlay. Instead it runs a loop of plain commands:

```
screens --json          → device list (real pixel dimensions, cached)
snap --screen N         → one native-resolution PNG frame
  (the agent reads the image with vision and selects an area)
record --screen N --crop x:y:w:h --json     (detached; prompt returns at once)
status --json           → is a recording in progress — what, where, how long
stop --json             → stop + verify the recording with ffprobe
```

**The main point:** `snap` writes the image at the native pixel
resolution of the same capture device that `record` will use. The
coordinates the agent reads from the image therefore map **1:1** to
`--crop`; no conversion step exists. The classic defect source of screen
tools (three coordinate systems: AppKit points, CGWindowList points,
avfoundation pixels) never enters the agent flow.

## The contract

- `--json` on every command; JSON is the interface for agents
- Exit codes: `0` = OK, `1` = runtime error, `2` = argument error
- `--crop x:y:w:h` is pixels of the capture frame of the selected screen. A
  crop that does not fit exits `2` with the real screen size; pomulum does
  not shrink it silently. A crop that fits only partly comes back as
  `requestedCrop` next to the applied `crop`, with `cropClamped: true`
- One recording at a time (pidfile `/tmp/pomulum-rec.pid`)
- A recording started without `--duration` is capped at 30 minutes
  (`--max-duration 0` removes the cap); an agent that walks away must not
  fill the disk

## Non-goals

We protect the primitive shape on purpose:

- **No edit, trim, conversion, or upload**: the verified recording
  leaves pomulum and enters the next tool. Every added media feature
  re-creates a GUI product with a config surface an agent must relearn.
- **No scheduling or event triggers**: the agent waits; pomulum acts only
  when called.
- **No concurrent recordings**: one pidfile is the whole state machine,
  so `status` can always answer truthfully with one line of JSON.
- **No GUI, daemon, or config file**: the contract is flags + JSON +
  exit codes, readable on one screen.

## Process model

- `record` spawns **detached** under `caffeinate -i` (App Nap prevention).
  The child becomes the leader of its process group, so `stop` can signal
  the whole group (caffeinate + ffmpeg) with a negative pid.
- `stop` sends SIGINT to the group, waits, then escalates to SIGTERM and
  SIGKILL (ffmpeg blocked in avfoundation-init ignores SIGTERM). **We never
  trust the exit code**: ffmpeg exits 255 on a normal SIGINT.
  `stop` verifies the recording with ffprobe (streams, dimensions, duration)
  and reports that instead. A readable file is not enough: `stop` compares
  the length with `expectedSec` (the `-t` cap when ffmpeg reached it or
  ended on its own before it, else the wall clock up to the stop request)
  and exits with 1 on a short capture, with every fact in
  the JSON. avfoundation can stop delivering frames mid-capture and ffmpeg
  then exits cleanly with a short, valid mp4 (seen live: 0.63 s of a 3 s
  request).
- Immediate-failure detection: after the spawn, the parent waits ~1 s and
  checks that the child is alive; a dead child returns the tail of the
  ffmpeg log.

## Why one file of TypeScript

| Decision | Reason (measured, not taste) |
|---|---|
| One file, no npm dependencies, no build step | Run directly with `node pomulum.ts` on Node ≥ 22.18 (type stripping, erasable types only). No toolchain beyond Node + ffmpeg |
| TypeScript, not Rust/Go | Cross-platform, and the reference dev machine (8 GB, no rust/go toolchains) builds nothing; ffmpeg does the compute-heavy work |
| Types only, no enums/namespaces | Type stripping requires erasable-only syntax |
| Pure functions for the parse, crop, and duration logic | `node --test pomulum.test.ts` covers the logic headless; tests import the same source file, so tested code is always the shipped code |

## Performance

- A recording costs about 1 of 6 CPU cores end to end at the
  full-resolution default (capture + encode; 0.5 cores with `--half`)
- pomulum caches the `screens` result on disk (~1.7 s → ~0.1 s); the key is
  the signature of the device list, with a 1 h TTL; `--no-cache` bypasses it
- pomulum **discovers device indexes at runtime and never hardcodes them**:
  the avfoundation index map changes when displays are plugged or unplugged
