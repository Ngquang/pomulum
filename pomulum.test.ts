// pomulum.test.ts — run with `node --test pomulum.test.ts`
// Tests for the pure functions only (parsing, crop geometry, timestamp).
// They do not touch ffmpeg or permissions, so they run headless at all times.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  HALF_SCALE_FILTER,
  RunError,
  SHORTFALL_ALLOWANCE_CAP_SEC,
  SHORTFALL_ALLOWANCE_WALL_SEC,
  TCC_REMEDY,
  UsageError,
  appBundleRoot,
  asciiTimestamp,
  buildFfmpegArgs,
  captureVerdict,
  clampCrop,
  cropUnusable,
  cropWasClamped,
  effectiveDurationCap,
  evenAligned,
  expectedCapture,
  locateToolchain,
  looksLikeOurRecorder,
  parseArgv,
  parseCropSpec,
  parseDeviceList,
  parsePidfile,
  requireWritableDir,
  resolveEncodeMode,
  resolveScreenPermission,
  scaledDims,
  screensNeedingProbe,
  selectScreen,
  stopWarnings,
  tccHint,
  tccutilLine,
  videoFilter,
} from "./pomulum.ts";

// Fixture path relative to THIS file, so the suite runs from any working
// directory (repo root, pomulum/, or elsewhere).
const FIXTURES = fileURLToPath(new URL("./tests/fixtures/", import.meta.url));

// ── parseArgv ────────────────────────────────────────────────────────────

test("parseArgv: basic bool flag and value flag", () => {
  const a = parseArgv("record", ["--crop", "1:2:3:4", "--no-mic"], {
    "--crop": "value",
    "--no-mic": "bool",
  });
  assert.equal(a.values["--crop"], "1:2:3:4");
  assert.equal(a.bools.has("--no-mic"), true);
});

test("parseArgv: an unknown flag causes a UsageError", () => {
  assert.throws(() => parseArgv("record", ["--nonsense"], {}), UsageError);
});

test("parseArgv: a value flag at the end without a value causes a UsageError", () => {
  assert.throws(() => parseArgv("record", ["--crop"], { "--crop": "value" }), UsageError);
});

test("parseArgv: a value flag must not swallow a following flag", () => {
  // `record --out --json` used to store "--json" as the filename and drop
  // the bool silently — the JSON contract must not depend on flag order.
  assert.throws(() => parseArgv("record", ["--out", "--json"], { "--out": "value" }), UsageError);
});

test("parseArgv: every command accepts --help", () => {
  const a = parseArgv("screens", ["--help"], {});
  assert.equal(a.bools.has("--help"), true);
});

// ── crop geometry ────────────────────────────────────────────────────────

test("evenAligned: round down to even, minimum 2", () => {
  assert.deepEqual(evenAligned({ x: 5, y: 7, w: 101, h: 53 }), { x: 4, y: 6, w: 100, h: 52 });
  assert.deepEqual(evenAligned({ x: 1, y: 1, w: 1, h: 1 }), { x: 0, y: 0, w: 2, h: 2 });
});

test("parseCropSpec: a correct format gives an even-aligned crop", () => {
  assert.deepEqual(parseCropSpec("100:200:800:600"), { x: 100, y: 200, w: 800, h: 600 });
  assert.deepEqual(parseCropSpec("101:203:801:601"), { x: 100, y: 202, w: 800, h: 600 });
});

test("parseCropSpec: an incorrect format causes a UsageError", () => {
  // Negative x and y are valid (clampCrop clamps them later); w and h must be positive.
  for (const bad of ["1:2:3", "1:2:3:4:5", "a:b:c:d", "1:2:0:4", "1:2:3:0"]) {
    assert.throws(() => parseCropSpec(bad), UsageError, `must throw for ${bad}`);
  }
});

test("clampCrop: a crop past the limit stays inside and becomes even", () => {
  // Device 2816x1762; the crop x value is too close to the right edge.
  const r = clampCrop({ x: 2800, y: 1700, w: 100, h: 100 }, 2816, 1762);
  assert.ok(r.x + r.w <= 2816, "x+w must not pass the width");
  assert.ok(r.y + r.h <= 1762, "y+h must not pass the height");
  assert.ok(r.w >= 2 && r.h >= 2);
  assert.equal(r.w % 2, 0);
  assert.equal(r.h % 2, 0);
});

test("clampCrop: a negative crop gives a minimum 2x2 at the origin", () => {
  const r = clampCrop({ x: -5, y: -5, w: -10, h: -10 }, 2816, 1762);
  assert.deepEqual(r, { x: 0, y: 0, w: 2, h: 2 });
});

test("cropWasClamped: true only when the clamp moved or shrank the request", () => {
  const want = { x: 100, y: 100, w: 400, h: 300 };
  assert.equal(cropWasClamped(want, want), false);
  assert.equal(cropWasClamped(want, { ...want, x: 96 }), true);
  assert.equal(cropWasClamped(want, { ...want, w: 398 }), true);
  // The documented defect: 5000:5000:100:200 on a 2816x1762 screen used to
  // reach ffmpeg as a 2x2 crop with nothing in the JSON saying so.
  const applied = clampCrop({ x: 5000, y: 5000, w: 100, h: 200 }, 2816, 1762);
  assert.deepEqual(applied, { x: 2814, y: 1760, w: 2, h: 2 });
  assert.equal(cropWasClamped({ x: 5000, y: 5000, w: 100, h: 200 }, applied), true);
  assert.equal(cropUnusable(applied, true), true);
});

test("cropUnusable: the floor is on the OUTPUT, so --full-res allows more", () => {
  assert.equal(cropUnusable({ x: 0, y: 0, w: 16, h: 16 }, true), false); // 8x8 out
  assert.equal(cropUnusable({ x: 0, y: 0, w: 14, h: 40 }, true), true); // 7 px out — a smear
  assert.equal(cropUnusable({ x: 0, y: 0, w: 14, h: 40 }, false), false); // 14 px out is fine
  assert.equal(cropUnusable({ x: 0, y: 0, w: 8, h: 300 }, false), false);
  assert.equal(cropUnusable({ x: 0, y: 0, w: 6, h: 300 }, false), true);
});

test("scaledDims: the promise matches the filter that produces the frame", () => {
  // The one string that scales, and the pure model of it, cannot drift: a
  // mismatch here is what made `expectedDims` lie about the file.
  const vf = videoFilter({
    videoDevice: 1,
    micDevice: null,
    crop: null,
    downscale: true,
    crf: 26,
    preset: "veryfast",
    framerate: 30,
    durationSec: null,
  });
  assert.equal(vf, HALF_SCALE_FILTER);
  const m = /trunc\(iw\/(\d+)\)\*(\d+)/.exec(HALF_SCALE_FILTER);
  assert.ok(m, "the half-scale filter must keep its trunc(iw/N)*M shape");
  const n = Number(m[1]);
  const mult = Number(m[2]);
  for (const [w, h] of [[18, 18], [100, 66], [2816, 1762], [800, 600]] as const) {
    assert.deepEqual(
      scaledDims(w, h, true),
      { w: Math.trunc(w / n) * mult, h: Math.trunc(h / n) * mult },
      `formula drift for ${w}x${h}`,
    );
  }
  // Full screen, no crop: the filter still applies, so the promise must cover it.
  assert.deepEqual(scaledDims(2816, 1762, true), { w: 1408, h: 880 });
});

test("scaledDims: always even, so libx264 can open yuv420p", () => {  // The documented defect: 18 px half scales to 9 with `scale=iw/2`, and the
  // encoder refuses an odd width — the file is unreadable.
  assert.deepEqual(scaledDims(18, 18, true), { w: 8, h: 8 });
  assert.deepEqual(scaledDims(22, 30, true), { w: 10, h: 14 });
  assert.deepEqual(scaledDims(800, 600, true), { w: 400, h: 300 });
  assert.deepEqual(scaledDims(2816, 1762, true), { w: 1408, h: 880 }); // measured source
  assert.deepEqual(scaledDims(14, 6, true), { w: 6, h: 2 });
  // --full-res keeps the crop as it is (it is even-aligned already).
  assert.deepEqual(scaledDims(18, 18, false), { w: 18, h: 18 });
  for (const [w, h] of [[2, 2], [6, 10], [18, 22], [100, 66]] as const) {
    const d = scaledDims(w, h, true);
    assert.equal(d.w % 2, 0, `${w} wide must give an even output`);
    assert.equal(d.h % 2, 0, `${h} high must give an even output`);
  }
});

// ── timestamp ────────────────────────────────────────────────────────────

test("asciiTimestamp: ASCII characters only, correct format", () => {
  const s = asciiTimestamp(new Date(2026, 9, 12, 13, 4, 5));
  assert.equal(s, "2026-10-12_13-04-05");
  // ASCII-safe: no U+202F and no other Unicode character.
  assert.ok(/^[\x20-\x7E]+$/.test(s), `string has a non-ASCII character: ${JSON.stringify(s)}`);
});

// ── toolchain ────────────────────────────────────────────────────────────

test("locateToolchain: finds ffmpeg/ffprobe on this machine", () => {
  const t = locateToolchain();
  assert.ok(t, "the toolchain must be found");
  assert.ok(t!.ffmpeg.endsWith("/ffmpeg"), `unexpected ffmpeg path: ${t!.ffmpeg}`);
  assert.ok(t!.ffprobe.endsWith("/ffprobe"), `unexpected ffprobe path: ${t!.ffprobe}`);
  // Distributions differ (Apple silicon: /opt/homebrew/bin, Intel: /usr/local/bin) —
  // only the resolution, not the concrete path, is part of the contract.
});

// ── parseDeviceList (M2 — fixture) ───────────────────────────────────────

test("parseDeviceList: this-machine fixture — 1 screen, face camera removed, 1 microphone", () => {
  const raw = readFileSync(`${FIXTURES}avfoundation-mac17-5-1screen.txt`, "utf8");
  const { screens, mics } = parseDeviceList(raw);
  // The face camera must be FILTERED OUT (pitfall #3: a probe of the camera blocks).
  assert.equal(screens.length, 1);
  assert.equal(screens[0]!.name, "Capture screen 0");
  assert.equal(screens[0]!.index, 1);
  assert.ok(!JSON.stringify(screens).includes("MacBook Neo Camera"));
  assert.equal(mics.length, 1);
  assert.equal(mics[0]!.name, "MacBook Neo Microphone");
  assert.equal(mics[0]!.index, 0);
});

test("parseDeviceList: synthetic 2 screens + 2 microphones — audio section splits correctly", () => {
  const raw = [
    `[AVFoundation indev @ 0x1] AVFoundation video devices:`,
    `[AVFoundation indev @ 0x1] [0] FaceTime HD Camera`,
    `[AVFoundation indev @ 0x1] [1] Capture screen 0`,
    `[AVFoundation indev @ 0x1] [2] Capture screen 1`,
    `[AVFoundation indev @ 0x1] AVFoundation audio devices:`,
    `[AVFoundation indev @ 0x1] [0] MacBook Neo Microphone`,
    `[AVFoundation indev @ 0x1] [1] BlackHole 2ch`,
    ``,
  ].join("\n");
  const { screens, mics } = parseDeviceList(raw);
  assert.deepEqual(
    screens.map((s) => s.index),
    [1, 2],
  );
  assert.deepEqual(
    mics.map((m) => m.name),
    ["MacBook Neo Microphone", "BlackHole 2ch"],
  );
});

test("parseDeviceList: garbage output gives empty lists and does not throw", () => {
  const { screens, mics } = parseDeviceList("ffmpeg version 8.1\nblah blah\n");
  assert.equal(screens.length, 0);
  assert.equal(mics.length, 0);
});

// ── buildFfmpegArgs (M4 — golden tests, port EncodeConfig.swift) ─────────

test("buildFfmpegArgs: crop + mic + duration — golden", () => {
  const args = buildFfmpegArgs(
    {
      videoDevice: 1,
      micDevice: 0,
      crop: { x: 100, y: 200, w: 800, h: 600 },
      downscale: true,
      crf: 26,
      preset: "veryfast",
      framerate: 30,
      durationSec: 10,
    },
    "/tmp/out.mp4",
  );
  assert.deepEqual(args, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "avfoundation",
    "-framerate", "30",
    "-pixel_format", "nv12",
    "-capture_cursor", "1",
    "-i", "1:0",
    "-vf", "crop=800:600:100:200,scale=trunc(iw/4)*2:trunc(ih/4)*2",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "96k",
    "-movflags", "+faststart",
    "-metadata", "comment=pomulum-recording",
    "-t", "10",
    "/tmp/out.mp4",
  ]);
});

test("buildFfmpegArgs: no mic gives -an; full screen at full resolution gives no -vf", () => {
  const args = buildFfmpegArgs(
    {
      videoDevice: 2,
      micDevice: null,
      crop: null,
      downscale: false,
      crf: 28,
      preset: "veryfast",
      framerate: 30,
      durationSec: null,
    },
    "/tmp/o2.mp4",
  );
  assert.deepEqual(args, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "avfoundation",
    "-framerate", "30",
    "-pixel_format", "nv12",
    "-capture_cursor", "1",
    "-i", "2",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p",
    "-an",
    "-movflags", "+faststart",
    "-metadata", "comment=pomulum-recording",
    "/tmp/o2.mp4",
  ]);
});

// ── effectiveDurationCap (v0.1 — time-limit guard) ───────────────────────

test("effectiveDurationCap: --duration wins over every limit", () => {
  assert.equal(effectiveDurationCap(10, null), 10);
  assert.equal(effectiveDurationCap(10, 1800), 10);
  assert.equal(effectiveDurationCap(10, 0), 10);
});

test("effectiveDurationCap: without --duration use max-duration or the default 1800", () => {
  assert.equal(effectiveDurationCap(null, null), 1800); // default
  assert.equal(effectiveDurationCap(null, 300), 300); // override
  assert.equal(effectiveDurationCap(null, 0), null); // 0 = no limit
});

// ── selectScreen (shared device selection, pure) ─────────────────────────

const FIXTURE_SCREENS = [
  { index: 1, name: "Capture screen 0", width: null, height: null },
  { index: 2, name: "Capture screen 1", width: null, height: null },
];

test("selectScreen: without --screen return the first screen; with a valid index return it", () => {
  assert.equal(selectScreen(FIXTURE_SCREENS, undefined).index, 1);
  assert.equal(selectScreen(FIXTURE_SCREENS, "2").index, 2);
});

test("selectScreen: an unknown index throws a UsageError that lists the devices; an empty list throws a RunError", () => {
  assert.throws(() => selectScreen(FIXTURE_SCREENS, "99"), UsageError);
  assert.throws(() => selectScreen(FIXTURE_SCREENS, "-1"), UsageError);
  assert.throws(() => selectScreen([], undefined), RunError);
});

test("selectScreen: zero screens names the host app, never ffmpeg (the TCC model)", () => {
  // This message is what a user sees when the grant was lost, so it must
  // carry the correct remedy — the app that runs the capture. `check.sh`
  // scans every shipped file for the wrong phrasing; this test pins the
  // message to the one shared remedy string.
  const e = (() => {
    try {
      selectScreen([], undefined);
      return null;
    } catch (err) {
      return err as RunError;
    }
  })();
  assert.ok(e, "selectScreen must throw for an empty device list");
  assert.ok(e!.message.includes(TCC_REMEDY));
});

// ── looksLikeOurRecorder (a stronger pid check) ──────────────────────────

test("looksLikeOurRecorder: only the marked recorder matches — never a foreign avfoundation capture", () => {
  const ours = "/usr/bin/caffeinate -i /opt/homebrew/bin/ffmpeg -hide_banner -f avfoundation -framerate 30 -i 1:0 -c:v libx264 -metadata comment=pomulum-recording out.mp4";
  const foreignCapture = "/opt/homebrew/bin/ffmpeg -f avfoundation -i 2 -c:v libx264 out.mp4";
  const plainTranscode = "/opt/homebrew/bin/ffmpeg -i in.mov -c:v libx264 -crf 26 out.mp4";
  assert.equal(looksLikeOurRecorder(ours), true);
  assert.equal(looksLikeOurRecorder(foreignCapture), false);
  assert.equal(looksLikeOurRecorder(plainTranscode), false);
  assert.equal(looksLikeOurRecorder(""), false);
});

// ── parsePidfile (the pidfile format has one test surface) ───────────────

test("parsePidfile: a pending claim parses to the pending state", () => {
  const s = parsePidfile(JSON.stringify({ state: "pending", output: "/tmp/x.mp4", startedAt: "2026-10-15T10:00:00.000Z" }));
  assert.equal(s.state, "pending");
  assert.equal(s.output, "/tmp/x.mp4");
});

test("parsePidfile: a recording parses with every field, and defaults crop/mic/capSec", () => {
  const s = parsePidfile(
    JSON.stringify({
      state: "recording",
      pid: 4242,
      output: "/tmp/x.mp4",
      command: "ffmpeg ...",
      startedAt: "2026-10-15T10:00:00.000Z",
      device: { index: 3, name: "Capture screen 0", width: 2816, height: 1762 },
    }),
  );
  assert.equal(s.state, "recording");
  if (s.state !== "recording") return; // narrow for the reader and the compiler
  assert.equal(s.pid, 4242);
  assert.equal(s.device.index, 3);
  assert.equal(s.crop, null);
  assert.equal(s.mic, null);
  assert.equal(s.capSec, null);
});

test("parsePidfile: capSec round-trips as a positive number and nothing else", () => {
  const base = { state: "recording", pid: 7, output: "/tmp/x.mp4", command: "ffmpeg", startedAt: "2026-10-15T10:00:00.000Z", device: { index: 1, name: "s" } };
  const withCap = parsePidfile(JSON.stringify({ ...base, capSec: 1800 }));
  assert.equal(withCap.state === "recording" && withCap.capSec, 1800);
  for (const capSec of [0, -3, "60", null]) {
    const s = parsePidfile(JSON.stringify({ ...base, capSec }));
    assert.equal(s.state === "recording" && s.capSec, null, `capSec ${JSON.stringify(capSec)} must read as null`);
  }
});

test("parsePidfile: corrupt JSON, an unknown shape, and a bad pid are all rejected", () => {
  assert.throws(() => parsePidfile("not json{{{"), RunError);
  // The pre-union format has no `state` field: it must not be
  // silently accepted, and must not look like "no recording".
  assert.throws(
    () =>
      parsePidfile(
        JSON.stringify({ pid: 1, output: "/tmp/x.mp4", command: "ffmpeg", startedAt: "2026-10-15T10:00:00.000Z", device: { index: 1, name: "s", width: 1, height: 1 }, crop: null, mic: null }),
      ),
    RunError,
  );
  for (const pid of [0, -5, 1.5]) {
    assert.throws(
      () =>
        parsePidfile(
          JSON.stringify({ state: "recording", pid, output: "/tmp/x.mp4", command: "ffmpeg", startedAt: "2026-10-15T10:00:00.000Z", device: { index: 1, name: "s" } }),
        ),
      RunError,
      `pid ${pid} must be rejected`,
    );
  }
  assert.throws(() => parsePidfile(JSON.stringify({ state: "pending", output: "/tmp/x.mp4" })), RunError);
  // a startedAt that does not parse would make every wall-clock number NaN
  assert.throws(
    () => parsePidfile(JSON.stringify({ state: "pending", output: "/tmp/x.mp4", startedAt: "yesterday-ish" })),
    RunError,
  );
});

// ── capture verdict (a readable file is not yet the file the agent asked for) ──

test("expectedCapture: a reached cap is the expectation with the tight allowance; otherwise the wall clock", () => {
  assert.deepEqual(expectedCapture(3, 7.4, true), { expectedSec: 3, allowanceSec: SHORTFALL_ALLOWANCE_CAP_SEC });
  assert.deepEqual(expectedCapture(60, 60, true), { expectedSec: 60, allowanceSec: SHORTFALL_ALLOWANCE_CAP_SEC });
  // stopped by hand before the cap: the wall clock is what the agent waited
  assert.deepEqual(expectedCapture(60, 10.2, false), { expectedSec: 10.2, allowanceSec: SHORTFALL_ALLOWANCE_WALL_SEC });
  assert.deepEqual(expectedCapture(null, 10.2, false), { expectedSec: 10.2, allowanceSec: SHORTFALL_ALLOWANCE_WALL_SEC });
  assert.deepEqual(expectedCapture(null, -0.3, true), { expectedSec: 0, allowanceSec: SHORTFALL_ALLOWANCE_WALL_SEC });
});

test("expectedCapture: ffmpeg ending on its own before its cap is a stall or a crash, so the cap is the measure", () => {
  // --duration 60, frames stall at 20 s, ffmpeg exits at 21.5 s, stop at 23 s:
  // a wall-clock expectation (4.6 s threshold) would wave the defect through
  assert.deepEqual(expectedCapture(60, 23, true), { expectedSec: 60, allowanceSec: SHORTFALL_ALLOWANCE_CAP_SEC });
  assert.equal(captureVerdict(20, expectedCapture(60, 23, true)).short, true);
  // the same file and wall clock, but WE sent the SIGINT: an intentional
  // early stop, not a defect
  assert.equal(captureVerdict(20, expectedCapture(60, 23, false)).short, false);
  // a capped recording that ends on its own just past the cap is fine
  assert.equal(captureVerdict(59.97, expectedCapture(60, 61, true)).short, false);
});

test("captureVerdict: the live defect (0.63 s out of a 3 s request) is short; a frame-accurate cap is not", () => {
  const live = captureVerdict(0.633334, expectedCapture(3, 7.5, true));
  assert.equal(live.short, true);
  assert.equal(live.expectedSec, 3);
  assert.equal(live.shortfallSec, 2.4);
  const exact = captureVerdict(59.966667, expectedCapture(60, 61.2, true));
  assert.equal(exact.short, false);
  assert.equal(exact.shortfallSec, 0);
});

test("captureVerdict: the allowance absorbs warm-up on wall-clock stops; a stall is still short", () => {
  // 10 s by hand, 8 s of frames: spawn + warm-up + flush, not a defect
  assert.equal(captureVerdict(8, expectedCapture(null, 10, false)).short, false);
  // 10 s by hand, 2 s of frames: avfoundation stalled
  assert.equal(captureVerdict(2, expectedCapture(null, 10, false)).short, true);
  // a 1 s request keeps its warm-up (0.4 s shortfall is under the 1 s allowance)
  assert.equal(captureVerdict(0.6, expectedCapture(1, 1.8, true)).short, false);
  // 20 % rule on long caps: 12 s missing out of 60 is the edge, 12.1 is short
  assert.equal(captureVerdict(48, expectedCapture(60, 60, true)).short, false);
  assert.equal(captureVerdict(47.9, expectedCapture(60, 60, true)).short, true);
  // a file longer than the expectation is never short
  assert.equal(captureVerdict(12, expectedCapture(null, 10, false)).shortfallSec, 0);
});

test("stopWarnings: a requested mic with no audio track is reported; no mic or audio present is silent", () => {
  assert.deepEqual(stopWarnings(null, false), []);
  assert.deepEqual(stopWarnings(1, true), []);
  const w = stopWarnings(0, false);
  assert.equal(w.length, 1);
  assert.match(w[0], /mic 0 was requested/);
  assert.match(w[0], /no audio track/);
});

test("RunError: details ride along for the --json error object and default to an empty object", () => {
  const plain = new RunError("x");
  assert.deepEqual(plain.details, {});
  assert.equal(plain.message, "x");
  const rich = new RunError("short", { shortCapture: true, output: "/tmp/x.mp4" });
  assert.deepEqual(rich.details, { shortCapture: true, output: "/tmp/x.mp4" });
  assert.ok(rich instanceof Error);
});

// ── tccHint (remedy hint for a lost Screen Recording grant) ──────────────

test("tccHint: a killed probe (rc null) or objc noise yields the hint; a clean run does not", () => {
  assert.ok(tccHint(null, "objc[1]: class `X' not linked into application").includes("Screen Recording"));
  assert.ok(tccHint(null, "").includes("Screen Recording"));
  assert.ok(tccHint(1, "not linked into application").includes("Screen Recording"));
  assert.equal(tccHint(1, "Device or resource busy"), "");
  assert.equal(tccHint(0, ""), "");
});

test("tccHint: the hint is the shared remedy, and it points at the host app", () => {
  const hint = tccHint(null, "");
  assert.ok(hint.includes(TCC_REMEDY));
  assert.ok(/never to ffmpeg/.test(TCC_REMEDY));
  assert.ok(/reopen THAT app/.test(TCC_REMEDY)); // the relaunch step is in the shared remedy
});

test("tccHint: a known bundle id adds the targeted tccutil command; no id adds none", () => {
  const withId = tccHint(null, "", "com.example.host");
  assert.ok(withId.includes("tccutil reset ScreenCapture com.example.host"));
  const withoutId = tccHint(null, "");
  assert.ok(!withoutId.includes("tccutil"));
  assert.ok(tccutilLine("com.example.host").includes("reopen the app"));
});

// ── resolveScreenPermission (classify a screens run) ─────────────────────

test("resolveScreenPermission: screens win, screens-less-with-mics is blocked, both empty is no-devices", () => {
  assert.equal(resolveScreenPermission([1, 2], []), "ok");
  assert.equal(resolveScreenPermission([], [{ index: 0, name: "mic" }]), "blocked");
  assert.equal(resolveScreenPermission([], []), "no-devices");
});

// ── appBundleRoot (bundle root from an app-bundle executable path) ───────

test("appBundleRoot: app-bundle paths resolve to the .app root; other paths are null", () => {
  assert.equal(appBundleRoot("/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"), "/Applications/DeepSeek Harness.app");
  assert.equal(appBundleRoot("/usr/local/bin/node"), null);
  assert.equal(appBundleRoot("Relative.app/Contents/MacOS/Rel"), null); // not absolute
});

// ── requireWritableDir (a missing folder is not a denied folder) ─────────

test("requireWritableDir: a missing directory says so; it does not blame a permission", () => {
  const missing = "/tmp/pomulum-no-such-dir-8f3a9c/out.mp4";
  const e = (() => {
    try {
      requireWritableDir(missing);
      return null;
    } catch (err) {
      return err as RunError;
    }
  })();
  assert.ok(e, "a missing output directory must be refused");
  assert.ok(/does not exist/.test(e!.message), `unexpected message: ${e!.message}`);
  assert.ok(!/permission/i.test(e!.message));
  assert.ok(e!.message.includes("/tmp/pomulum-no-such-dir-8f3a9c"));
});

test("requireWritableDir: an existing writable directory passes", () => {
  requireWritableDir("/tmp/pomulum-unit-test-output.mp4"); // must not throw
});

// ── resolveEncodeMode (the 0.2.0 flag semantics, pinned) ─────────────────

test("resolveEncodeMode: the default is full resolution at CRF 26", () => {
  assert.deepEqual(resolveEncodeMode({ fullRes: false, half: false, small: false }), {
    downscale: false,
    crf: 26,
  });
});

test("resolveEncodeMode: --half opts into the 50% scale", () => {
  assert.deepEqual(resolveEncodeMode({ fullRes: false, half: true, small: false }), {
    downscale: true,
    crf: 26,
  });
});

test("resolveEncodeMode: --small is CRF 28 + half scale", () => {
  assert.deepEqual(resolveEncodeMode({ fullRes: false, half: false, small: true }), {
    downscale: true,
    crf: 28,
  });
});

test("resolveEncodeMode: --full-res overrides the half scale and keeps CRF 28 with --small", () => {
  assert.deepEqual(resolveEncodeMode({ fullRes: true, half: true, small: false }), {
    downscale: false,
    crf: 26,
  });
  assert.deepEqual(resolveEncodeMode({ fullRes: true, half: true, small: true }), {
    downscale: false,
    crf: 28,
  });
});

// ── screensNeedingProbe (a cache hit is not a promise about every device) ──

test("screensNeedingProbe: a cold cache probes every screen", () => {
  const screens = [
    { index: 1, name: "Capture screen 0", width: null, height: null },
    { index: 2, name: "Capture screen 1", width: null, height: null },
  ];
  assert.deepEqual(screensNeedingProbe(screens, {}), screens);
});

test("screensNeedingProbe: a partial cache (one record) probes only the rest", () => {
  // The 0.1.1 defect: record --screen 2 wrote only device 2 into the cache,
  // and screens reported device 1 as null instead of probing it.
  const screens = [
    { index: 1, name: "Capture screen 0", width: null, height: null },
    { index: 2, name: "Capture screen 1", width: null, height: null },
  ];
  const dims = { "2": { w: 2560, h: 1440 } };
  assert.deepEqual(screensNeedingProbe(screens, dims), [screens[0]]);
});

test("screensNeedingProbe: a complete cache probes nothing", () => {
  const screens = [
    { index: 1, name: "Capture screen 0", width: null, height: null },
    { index: 2, name: "Capture screen 1", width: null, height: null },
  ];
  const dims = { "1": { w: 2816, h: 1762 }, "2": { w: 2560, h: 1440 } };
  assert.deepEqual(screensNeedingProbe(screens, dims), []);
});
