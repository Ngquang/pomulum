<p align="center"><img src="assets/icon.svg" width="120" alt="pomulum"></p>

# pomulum — agent screen recorder

**pomulum is not a recorder app — it is the recording primitive of an
agent loop on macOS.** One command to see (`snap`), one to act
(`record`, `stop`), one contract to trust (`--json` + ffprobe). An agent
captures a frame, reads it with vision, selects an area in pixels,
records that area, and gets a JSON verdict — no GUI at any step (a human
can drive the same loop from a shell). The engine is ffmpeg; pomulum
itself needs no Screen Recording permission — macOS attributes the grant
to the app that launches the capture (your terminal or agent host, see
Requirements). **No dependencies, no build step** — run it directly with
Node >= 22.18 (type stripping).

## What is in the name

*pōmulum* is Latin for **a little apple** — the diminutive of *pomum*, fruit
([Lewis & Short](https://www.perseus.tufts.edu/hopper/text?doc=Perseus:text:1999.04.0059:entry=pomulum)).
Apple got the big apple and put a beautiful screen on it; pomulum is the small
one, and it does two small things well: it looks at that screen, and it shrinks
what it records. Hence the mark — four crop brackets around a REC dot.

## Why pomulum — the measured difference

The macOS default recorder optimizes for an editing master — no dropped
frames, high bitrate — not for "share it now". On a QHD desktop its files
run at ~700–820 KB/s, so a 2-minute demo is 83–98 MB. pomulum targets the
other job on purpose, and the encoder benchmark measured the trade
([docs/BENCHMARK.md](docs/BENCHMARK.md)):

| | macOS default recorder | pomulum (defaults) |
|---|---|---|
| File size, moving content | ~820 KB/s → ~98 MB / 2 min | **~105 KB/s → ~13 MB / 2 min** |
| Smaller by | — | **7.5×** — measured in a same-moment A/B of the same screen (one machine) |
| Quality (VMAF vs a lossless reference) | hardware encode, high bitrate | **94.6** at full res (the default), 91.0 at `--half` (CRF 26) |
| Operable by an agent | no — GUI overlay only | **JSON, exit codes, crop in pixels** |
| Scriptable file names | contain a U+202F narrow space that breaks globs and regexes | ASCII-safe (unit tested) |
| Cost when idle | — | **zero** — no daemon, no background process |

*A/B method: both recorders captured the same screen during the same minute
(one machine, 2026-10-18). On the never-scrolling UI chrome, pomulum's
output stays within VMAF ≈ 91 of Apple's own render — see
[docs/BENCHMARK.md](docs/BENCHMARK.md) for the alignment and normalization.*

Against "just script ffmpeg yourself": the raw avfoundation input blocks
forever without an undocumented pixel-format flag, a face-camera probe
hangs until it is killed, device indexes shift whenever displays come and
go, and ffmpeg exits 255 on a normal stop. pomulum is those pitfalls, paid
for once. A full-resolution recording costs about 1 of 6 CPU cores end to
end ([docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)).

## Requirements

- macOS (capture runs through avfoundation)
- Node >= 22.18 — [nodejs.org](https://nodejs.org/) or `brew install node`
  (type stripping runs by default from 22.18; on 22.6–22.17 it is behind
  `--experimental-strip-types` and is not supported)
- ffmpeg + ffprobe — `brew install ffmpeg`
- Screen Recording permission **for the app you run pomulum from** (your
  terminal or agent host — Terminal, iTerm, ZCode, ...): System Settings →
  Privacy & Security → Screen Recording → enable THAT entry. There is
  normally no `ffmpeg` entry; one appears only when ffmpeg is launched
  without an app wrapper (ssh, launchd)
  (see [Troubleshooting](#troubleshooting) when capture stops working)

## Get it

There is nothing to install: `pomulum.ts` is the whole program. Clone this
repo (or download that one file) and run it with Node — in a clone the file
sits at the top level:

```bash
node pomulum.ts --version          # prints the version — no build, no dependencies
```

## Quick start

```bash
node pomulum.ts screens --json                        # screens + mics (real dimensions, cached)
node pomulum.ts snap --out /tmp/s.png                 # one native-resolution frame (about 0.7 s)
node pomulum.ts record --crop x:y:w:h --duration 60   # detached; the microphone is on by default
node pomulum.ts status --json                         # is a recording in progress — what, where, how long
node pomulum.ts stop --json                           # stop and verify with ffprobe
```

Coordinates from a `snap` map 1:1 to `--crop` (the same pixel space of that
screen — no conversion). The full agent flow is in
[`skills/pomulum/SKILL.md`](skills/pomulum/SKILL.md).

## Install as a skill for other agents

```bash
bash skills/pomulum/install.sh --all   # every known host folder that exists
```

`--all` covers ZCode (`~/.zcode/skills`), the cross-agent convention
(`~/.agents/skills`) and Claude Code (`~/.claude/skills`). For one host, pass
the folder, or set `POMULUM_SKILL_DIR`:

```bash
bash skills/pomulum/install.sh ~/.claude/skills/pomulum
POMULUM_SKILL_DIR=~/.config/other-agent/skills/pomulum bash skills/pomulum/install.sh
```

The skill keeps a **copy** of `pomulum.ts`, not a symlink into the repo, so
run the installer again after every change — one `--all` keeps every host on
the same version.

## Tests

```bash
bash scripts/check.sh             # deterministic gates: contract, version, safety (no screen access)
node --test pomulum.test.ts       # unit tests (real fixture + golden args)  · npm test
bash scripts/e2e-pomulum-ts.sh    # headless end-to-end test with a real recording — log: /tmp/pomulum-e2e.log
```

## Quality

Every rule the code is held to lives in
[docs/STANDARDS.md](docs/STANDARDS.md), and each rule names its enforcement
home: a gate in `scripts/check.sh`, a unit test, the e2e script, CI, or a
named review step. If a rule cannot be checked yet, the file says so instead
of pretending.

CI runs the gates plus a strict typecheck on macOS and ubuntu, Node 22 and
24 ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)). The end-to-end
recording test stays manual: it needs a real screen and the Screen Recording
grant.

## Design

- **Encode sweet spot** ([docs/BENCHMARK.md](docs/BENCHMARK.md)): libx264
  CRF 26 veryfast at native resolution — VMAF 94.6, ~70–105 KB/s of motion
  (2-minute demo ≈ 8–13 MB; 7.5× smaller than the macOS default recorder in
  a same-moment A/B). `--half` trades resolution for ~55% size (VMAF 91.0)
- **One engine, one contract** ([docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)):
  ffmpeg does the capture and the encode; this file only controls the
  process. `--json` for every command · exit 0/1/2 · a 30-minute safety
  limit when `--duration` is not set (`--max-duration 0` removes it) ·
  one recording at a time
- `record` spawns **detached** under `caffeinate -i` (prevents App Nap);
  `stop` sends SIGINT to the full process group, then **verifies the
  artifact with ffprobe — the exit code is not trusted** (rc=255 on SIGINT
  is normal), then escalates to SIGTERM and SIGKILL

## Non-goals

pomulum stays a small, callable primitive. It deliberately does not:

- edit, trim, convert, or upload recordings — the verified mp4 goes into
  whatever tool does that next
- export GIFs or other formats — one ffmpeg line covers that outside
  pomulum
- schedule recordings or react to events — the agent decides when to call
- allow concurrent recordings — one pidfile, one truth
- ship a GUI, a daemon, or a config file — every option is a flag

## Troubleshooting

- **`screens` returns 0 screens, or a capture hangs/times out:** the
  Screen Recording permission (TCC) of your host app was lost. Open
  System Settings → Privacy & Security → Screen Recording and toggle the
  entry of the app that launched pomulum (Terminal, iTerm, ZCode, ...)
  **OFF and ON** — not `ffmpeg`. On recent macOS versions this grant often
  disappears after a display is connected or disconnected.
- **`--crop` values look wrong:** they are the pixels of the capture frame
  of the selected screen (origin = top left of THAT screen). Take the
  values from a `snap` made with the same `--screen N`. A crop that does not
  fit is **refused with exit 2** (it is never silently shrunk); a crop that
  fits only partly comes back in the JSON as `requestedCrop` next to the
  applied `crop`, with `cropClamped: true`.
- **The device list changed:** indexes shift when a display is connected
  or disconnected. Always read `screens` fresh; never hardcode an index.

## Logo

Four **crop brackets around a REC dot** — the agent selects a screen region,
then the recording light goes on. The design language is Omarchy's
(omarchy.org): a thick stroke, butt caps, miter joins, and a vertical gradient
cut into five hard bands instead of a blend. Files:
[`assets/icon.svg`](assets/icon.svg) and `icon-dark.svg` (light and dark mark),
plus their 512 px rasters `icon-512.png` and `icon-dark-512.png` for a site or a
social preview.

## History

pomulum started as a Swift menubar app (phases 1–2, 8/2026) with the same
ffmpeg engine and the same encode sweet spot. Since 10/2026 the product is
this agent CLI core, ported from the proven Swift pieces (device discovery,
encode config, artifact verification). Release notes:
[CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
