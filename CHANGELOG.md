# Changelog

Notable changes, newest first. `pomulum --version` is the only source of truth
for what you are running: the constant in `pomulum.ts`, `package.json`, and what
the CLI prints must agree, and `scripts/check.sh` fails the build if they do not.

## 0.2.0 — 2026-10-18

**The default is now full resolution.** The half-scale default had been
chosen while the benchmark's quality column was inflated by the swapped
libvmaf inputs (fixed in 0.1.1). Measured correctly: half scale is VMAF 91.0
and reads soft on real UI text; full resolution at CRF 26 is 94.6 — the same
band as a hardware encoder at 3× the size, and 7.5× smaller than the macOS
default recorder in a same-moment A/B of one screen
([docs/BENCHMARK.md](docs/BENCHMARK.md)).

- `--half` opts into the old 50% scale (VMAF 91.0, ~55% smaller).
- `--small` = CRF 28 + half scale — its output spec is unchanged.
- `--full-res` still forces full resolution and overrides the half scale of
  `--half`/`--small`, exactly as before — it is the default, so the flag
  only matters in combination.
- `expectedDims` stays exact for whatever mode runs. Agents that assumed
  half-scale output should read the field instead of computing it.

## 0.1.1 — 2026-10-18

Two correctness fixes found by an external claim benchmark (a 60 s live
recording of a second display, plus a re-run of the encoder matrix):

- `screens --json` no longer reports `width: null` for a device that a previous
  `record` left out of the dimension cache. A cache hit now covers only the
  devices the cache actually stores — the rest are probed and the completed
  map is written back (`screensNeedingProbe`). The defect needed a cold cache
  plus one single-device `record`: `record --screen 2 --dry-run`, then
  `screens` answered `nullxnull` for every other screen, with exit 0.
- `record --dry-run` no longer writes the dimension cache. A dry run reads
  and probes, but leaves no file behind — and it was the dry run that seeded
  the partial cache in the first place.

The benchmark also found that every published VMAF figure had been measured
with the libvmaf inputs swapped (the source passed as the distorted video).
The benchmark scripts now pass the encoded file first and scale the reference
to the encoded size, and the quality numbers in the README and
docs/BENCHMARK.md are re-measured with the corrected order.

## 0.1.0 — 2026-10-16

The first public release. One file, no dependencies, no build step:
`screens`, `snap`, `record`, `status`, `stop`; a `--json` contract with exit
codes 0 / 1 / 2; a 30-minute cap when no `--duration` is given
(`--max-duration 0` removes it); one recording at a time; half scale at CRF 26
([docs/BENCHMARK.md](docs/BENCHMARK.md)); and a `stop` that verifies the file
with ffprobe instead of trusting ffmpeg's exit code.

Behaviour worth knowing before you use it:

- `--crop x:y:w:h` is pixels of the capture frame of the selected screen. A crop
  that does not fit exits **2** with the real screen size — it is never shrunk
  silently. A crop that fits only partly comes back as `requestedCrop` next to
  the applied `crop`, with `cropClamped: true`.
- The half-scale frame is floored to an even size on both axes, which the
  encoder requires, and `expectedDims` in the JSON is exactly the size the file
  gets.
- `--version` (also `-v`, `version`) prints the version; `help` works like
  `--help`.
- An explicit `--duration` is never clamped to the 30-minute cap — the cap is
  for a recording that sets no duration at all.
- `install.sh --all` copies the skill into every agent host folder it finds, so
  several hosts cannot stay on different versions.

## Internal lineage (pre-public, kept for the record)

pomulum began as a private Swift menubar app (phases 1–2, 8/2026) with the same
ffmpeg engine and the same encode sweet spot, then became private TypeScript
iterations numbered 0.1.0–0.2.2. None of those versions were published, and the
internal numbers do not line up with the public one: public 0.1.0 is the sum of
them. What they settled lives in the code, the tests, and
[docs/STANDARDS.md](docs/STANDARDS.md). The decisions that still shape the
product:

- **0.2.2 (internal):** a crop that does not fit is refused instead of clamped;
  the half-scale filter can no longer ask for an odd width (libx264 refuses
  `yuv420p` at an odd width, and the unreadable file surfaced only later at
  `stop`); `expectedDims` became exact; and the Screen Recording remedy came
  from one shared constant after a user-facing message named the wrong app.
- **0.2.1 (internal):** the pidfile is claimed before the detached spawn, so two
  concurrent `record` calls cannot leave an untracked ffmpeg behind; one device
  listing per `record`; process identity checked against the real command line.
- **0.2.0 (internal):** the five commands, the JSON contract, the encode sweet
  spot, the public docs, and the agent skill.
- **0.1.0 (internal):** the first TypeScript CLI — avfoundation device
  discovery, one-frame snapshot, detached recording, ffprobe verification.
