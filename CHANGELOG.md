# Changelog

Notable changes, newest first. `pomulum --version` is the only source of truth
for what you are running: the constant in `pomulum.ts`, `package.json`, and what
the CLI prints must agree, and `scripts/check.sh` fails the build if they do not.

## 0.2.2 — 2026-10-21

The Screen Recording remedy now leads with the display check: a screen
that is off, a closed lid, or a remote session with no on-screen display
lists zero capture screens exactly like a lost grant. Confirmed live on
2026-10-21: both screens returned without any re-grant. On a host that
also lists microphones, `screenPermission` still reports "blocked" for
both causes; a mic-less host reports "no-devices". avfoundation offers
no signal to tell the two causes apart.

The README flow diagram is now a sequence diagram. It shows the real
division of work: the agent reads the snap and picks the crop itself,
ffmpeg encodes in one realtime pass, and `stop` verifies the file.

## 0.2.1 — 2026-10-20

**`stop` now fails a short capture.** A valid mp4 is not yet the file the
agent asked for: avfoundation can stop delivering frames and ffmpeg then
exits cleanly with a short file. Seen live on 2026-10-20: a 3 s request
produced 0.63 s, and `stop` reported it verified. `stop` now compares
`verified.durationSeconds` with `expectedSec` (the `--duration` cap when
ffmpeg reached it or ended on its own before it, else the wall clock up to
the stop request) and exits with 1 when the shortfall
is over 20 % and over the warm-up allowance (1 s on a reached cap, 2.5 s on
a wall-clock stop). The error JSON keeps every fact: `shortCapture: true`,
`shortfallSec`, `expectedSec`, `output`, the full `verified` block and
`kbPerSec`, so the agent can keep the file or record again.

- `stop` JSON gains `expectedSec` and `warnings` (always present). The one
  warning today: a requested mic that produced no audio track.
- `status --json` gains `capSec`: the `-t` limit the recording stops at on
  its own (`null` = none). The pidfile stores it.
- A `--json` runtime error can carry fields next to `error` and `class`.
  Agents that read only those two keys see no change.
- Repository: `SECURITY.md`, `CONTRIBUTING.md` and `AGENTS.md`;
  `package.json` names the repository, the bug tracker and a `bin`; a
  release workflow publishes a GitHub Release with `pomulum.ts` attached when
  a `v*` tag lands; README rewritten around the agent flow
  (`docs/flow.svg`).

`screens --json` now reports `screenPermission`: "ok", "blocked", or
"no-devices". avfoundation lists microphones without a grant, so a healthy
enumeration with zero screens points at the Screen Recording gate. A blocked
run also carries a `hint`: toggle Screen Recording for the host app, fully
quit and reopen it, and, when the bundle id is known, the exact
`tccutil reset ScreenCapture <bundle-id>` command. A running process
re-reads the permission only at launch, so the relaunch step is not
optional.

## 0.2.0 — 2026-10-18

**The default is now full resolution.** We chose the half-scale default while
the benchmark's quality column was inflated by the swapped libvmaf inputs
(fixed in 0.1.1). Measured again: half scale is VMAF 91.0 and looks soft on
real UI text. Full resolution at CRF 26 is 94.6, the same band as a hardware
encoder at 3× the size. In a same-moment A/B on one screen, it was 7.5×
smaller than the macOS default recorder ([docs/BENCHMARK.md](docs/BENCHMARK.md)).

- `--half` opts into the old 50% scale (VMAF 91.0, ~55% smaller).
- `--small` = CRF 28 + half scale; its output spec is unchanged.
- `--full-res` still forces full resolution and overrides the half scale of
  `--half`/`--small`, exactly as before. It is the default, so the flag
  only matters in combination.
- `expectedDims` stays exact for whatever mode runs. Agents that assumed
  half-scale output must read the field instead of computing it.

## 0.1.1 — 2026-10-18

Two correctness fixes found by an external claim benchmark (a 60 s live
recording of a second display, plus a re-run of the encoder matrix):

- `screens --json` no longer reports `width: null` for a device that a previous
  `record` left out of the dimension cache. A cache hit now covers only the
  devices in the cache; the rest are probed, and the completed map is written
  back (`screensNeedingProbe`). The defect needed a cold cache plus one
  single-device `record`: run `record --screen 2 --dry-run`, then `screens`
  answered `nullxnull` for every other screen, with exit 0.
- `record --dry-run` no longer writes the dimension cache. A dry run reads
  and probes but leaves no file behind. The dry run had seeded the partial
  cache.

The benchmark also found that every published VMAF figure had been measured
with the libvmaf inputs swapped (the source passed as the distorted video).
The benchmark scripts now pass the encoded file first and scale the reference
to the encoded size. We re-measured the quality numbers in the README and
docs/BENCHMARK.md with the corrected order.

## 0.1.0 — 2026-10-16

The first public release. One file, no dependencies, no build step.
Commands: `screens`, `snap`, `record`, `status`, `stop`. Contract: `--json`
with exit codes 0 / 1 / 2. A 30-minute cap applies when no `--duration` is
given (`--max-duration 0` removes it). One recording at a time. Half scale at
CRF 26 ([docs/BENCHMARK.md](docs/BENCHMARK.md)). `stop` verifies the file
with ffprobe instead of trusting ffmpeg's exit code.

Behaviour worth knowing before you use it:

- `--crop x:y:w:h` is pixels of the capture frame of the selected screen. A crop
  that does not fit exits **2** with the real screen size; pomulum never
  shrinks it silently. A crop that fits only partly comes back as
  `requestedCrop` next to the applied `crop`, with `cropClamped: true`.
- The half-scale frame is floored to an even size on both axes; the encoder
  requires it. `expectedDims` in the JSON is exactly the size the file gets.
- `--version` (also `-v`, `version`) prints the version; `help` works like
  `--help`.
- An explicit `--duration` is never clamped to the 30-minute cap; the cap is
  for a recording that sets no duration at all.
- `install.sh --all` copies the skill into every agent host folder it finds, so
  several hosts cannot stay on different versions.

## Internal lineage (pre-public, kept for the record)

pomulum began as a private Swift menubar app (phases 1–2, 8/2026) with the same
ffmpeg engine and the same preferred encode settings. It then became private
TypeScript iterations numbered 0.1.0–0.2.2. None of those versions were
published, and the internal numbers do not match the public one: public 0.1.0
is the sum of them. The code, the tests, and
[docs/STANDARDS.md](docs/STANDARDS.md) contain what they settled. The
decisions that still shape the product:

- **0.2.2 (internal):** a crop that does not fit is refused instead of clamped;
  the half-scale filter can no longer ask for an odd width (libx264 refuses
  `yuv420p` at an odd width). The unreadable file surfaced only later at
  `stop`. `expectedDims` became exact. The Screen Recording remedy came
  from one shared constant after a user-facing message named the wrong app.
- **0.2.1 (internal):** the pidfile is claimed before the detached spawn, so two
  concurrent `record` calls cannot leave an untracked ffmpeg behind; one device
  listing per `record`; process identity checked against the real command line.
- **0.2.0 (internal):** the five commands, the JSON contract, the preferred
  encode settings, the public docs, and the agent skill.
- **0.1.0 (internal):** the first TypeScript CLI: avfoundation device
  discovery, one-frame snapshot, detached recording, ffprobe verification.
