# Security

pomulum spawns ffmpeg and caffeinate, writes one mp4 and a few runtime
files, and opens no network connection. It has no dependencies: the supply
chain is Node, ffmpeg, and this one file.

## Report a vulnerability

Report privately through
[GitHub security advisories](https://github.com/Ngquang/pomulum/security/advisories/new),
not in a public issue. Useful reports: a `--crop`, `--out` or device value
that reaches a shell or escapes the output directory; a pidfile that makes
`stop` signal a foreign process; a way to capture without the host grant.

## What runs, and as whom

- **Permission model.** macOS attributes the Screen Recording grant to the
  app that launches pomulum (your terminal or agent host), not to pomulum or
  to ffmpeg. Anything that can run pomulum inside that app can record the
  screen and the default microphone. The host grant is the boundary.
- **Processes.** `record` spawns `caffeinate -i ffmpeg ...` detached, as one
  process group. `stop` signals that group only after it confirms, from the
  `ps` command line, that the pid is a pomulum recorder. No argument reaches
  a shell: every spawn passes an argv array, and `scripts/check.sh` fails
  the build when one does not.
- **Files.** Output: `~/Desktop/pomulum-<timestamp>.mp4`, or `--out`. The
  directory must exist and be writable; pomulum does not create it.
  Runtime: `/tmp/pomulum-rec.pid` (created exclusively, `O_EXCL`) and
  `/tmp/pomulum-ffmpeg.log`. Snapshots: `snap` writes the PNG named by
  `--out`, or `$TMPDIR/pomulum-snap-<timestamp>.png`; the dimension probe
  writes `$TMPDIR/pomulum-probe-<pid>-<device>.png` and removes it. Cache:
  `~/Library/Caches/pomulum/screen-cache.json` (the only directory pomulum
  creates). Nothing else is written.
- **Inputs.** Device indexes, crop values and durations are parsed as
  numbers and refused with exit 2 when they do not fit the screen or the
  range. Output paths are used as given: do not pass an untrusted `--out`.
- **Network.** None. No telemetry, no update check, no download.
- **Microphone.** On by default. Pass `--no-mic` when audio must not be
  captured. `stop` reports `hasAudio`, so the result can be checked.

The rules behind these points, and what enforces each, are in
[docs/STANDARDS.md](docs/STANDARDS.md).
