# pomulum: agent screen recorder

pomulum is the primitive an agent loop uses to record the screen on macOS.
One command to see (`snap`), two to act (`record`, `stop`), one contract to
trust (`--json` + ffprobe). No GUI appears at any step. One file, no
dependencies, no build step: run it with Node >= 22.18.

![pomulum flow: an agent calls pomulum, pomulum drives ffmpeg, stop verifies the file with ffprobe](docs/flow.svg)

## Why

- **Made for agents.** Every command answers in JSON with exit codes 0/1/2.
  A crop is pixels from `snap`, 1:1, with no conversion. The macOS recorder
  is a GUI overlay only.
- **Small files.** Full resolution at CRF 26 runs at about 105 KB/s: a
  2-minute demo is about 13 MB, 7.5x smaller than the macOS recorder in a
  same-moment A/B. VMAF 94.6 ([docs/BENCHMARK.md](docs/BENCHMARK.md)).
  `--half` trades resolution for about 55% less size (VMAF 91.0).
- **Zero cost when idle.** No daemon, no background process, no config file.
- **The avfoundation pitfalls, paid once.** The raw input blocks without an
  undocumented pixel-format flag. Device indexes shift when a display
  connects or disconnects. ffmpeg exits 255 on a normal stop. pomulum
  handles all three.

## Requirements

- macOS, Node >= 22.18 (`brew install node`), ffmpeg + ffprobe
  (`brew install ffmpeg`)
- Screen Recording permission **for the app you run pomulum from**
  (Terminal, iTerm, ZCode, ...): System Settings > Privacy & Security >
  Screen Recording. pomulum itself needs no grant. Do not look for an
  `ffmpeg` entry.

## Quick start

```bash
node pomulum.ts screens --json                        # screens, mics, permission state
node pomulum.ts snap --out /tmp/s.png                 # one native-resolution frame (~0.7 s)
node pomulum.ts record --crop x:y:w:h --duration 60   # detached; the mic is on by default
node pomulum.ts status --json                         # what is recording, where, how long
node pomulum.ts stop --json                           # stop, then verify with ffprobe
```

The agent loop: `screens`, then `snap`, then read the frame with vision and
pick a crop, then `record`, then `stop`. Without `--duration`, a 30-minute
safety limit applies (`--max-duration 0` removes it). The full flow is in
[`skills/pomulum/SKILL.md`](skills/pomulum/SKILL.md).

## Install as a skill

```bash
bash skills/pomulum/install.sh --all   # ZCode, ~/.agents/skills, Claude Code
```

The skill keeps a copy of `pomulum.ts`, not a symlink. Run the installer
again after every change.

## Troubleshooting

- **`screens` returns 0 screens, or a capture hangs.** Your host app lost
  its Screen Recording grant. Toggle THAT app OFF and ON in System
  Settings, then quit and reopen it. On recent macOS versions the grant often
  disappears when a display connects or disconnects.
- **A `--crop` does not fit.** pomulum refuses it with exit 2. A partial fit
  comes back clamped, with `cropClamped: true` in the JSON.
- **Device indexes changed.** They shift when a display connects or
  disconnects. Read `screens` fresh. Never hardcode an index.
- **`stop` exits 1 with `shortCapture: true`.** The file is valid but holds
  much less than `expectedSec`: avfoundation stopped delivering frames. The
  JSON still names the file and its `verified` facts. Record again.

## Security

pomulum runs with the Screen Recording grant of the app that launches it,
spawns ffmpeg without a shell, writes only the mp4, the snapshot PNGs and
its runtime files, and opens no network connection. Details, and how to
report a problem: [SECURITY.md](SECURITY.md).

## Development

```bash
bash scripts/check.sh             # deterministic gates: contract, version, safety
node --test pomulum.test.ts       # unit tests
bash scripts/e2e-pomulum-ts.sh    # headless end-to-end test with a real recording
```

Every rule and its enforcement is in [docs/STANDARDS.md](docs/STANDARDS.md).
CI runs the gates and a strict typecheck on macOS and ubuntu; a `v*` tag
publishes a GitHub Release with `pomulum.ts` attached. How to contribute:
[CONTRIBUTING.md](CONTRIBUTING.md). Conventions for coding agents:
[AGENTS.md](AGENTS.md). Design notes:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Release notes:
[CHANGELOG.md](CHANGELOG.md).

## Non-goals

pomulum stays a small, callable primitive. It does not edit, convert, or
upload recordings. It does not export GIFs, schedule captures, run two
recordings at once, or ship a GUI, a daemon, or a config file.

## License

[MIT](LICENSE)
