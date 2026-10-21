#!/usr/bin/env node
// pomulum — agent screen recorder CLI (v0, macOS)
//
// One file, no dependencies, no build step. Run it directly with Node >= 22.18
// (type stripping — erasable types only; on older Node 22 pass
// --experimental-strip-types). ffmpeg (avfoundation) does the
// capture and the encode; this file only controls the process. The Screen
// Recording permission belongs to the app that launches the capture (the
// terminal or agent host); this file needs none itself.
//
//   node pomulum.ts screens --json
//   node pomulum.ts snap --out /tmp/s.png
//   node pomulum.ts record --crop 400:300:800:600 --json
//   node pomulum.ts stop --json
//
// Convention: each command accepts --json (JSON is the contract for agents).
// Exit code: 0 = OK, 1 = runtime error, 2 = argument error.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const VERSION = "0.2.2";

// ─────────────────────────── types (erasable-only) ───────────────────────

export type Crop = { x: number; y: number; w: number; h: number };
export type ScreenDevice = { index: number; name: string; width: number | null; height: number | null };
export type MicDevice = { index: number; name: string };
export type Toolchain = { ffmpeg: string; ffprobe: string };

/** Argument error -> exit 2. */
export class UsageError extends Error {}
/** Runtime error (ffmpeg failed, no device found) -> exit 1. `details` go
 *  into the --json error object, so the agent keeps every fact the command
 *  had: a short capture still names the file it did produce. */
export class RunError extends Error {
  readonly details: Record<string, unknown>;
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.details = details;
  }
}

// ─────────────────────── toolchain (guardrail #2) ────────────────────────
// The PATH of an agent shell does not always contain /opt/homebrew/bin.
// Put the standard macOS locations first, then the PATH.

export function locateToolchain(): Toolchain | null {
  const dirs = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    ...(process.env.PATH ?? "").split(":"),
  ];
  let ffmpeg: string | undefined;
  let ffprobe: string | undefined;
  for (const d of dirs) {
    if (!d) continue;
    if (!ffmpeg && isExecutable(join(d, "ffmpeg"))) ffmpeg = join(d, "ffmpeg");
    if (!ffprobe && isExecutable(join(d, "ffprobe"))) ffprobe = join(d, "ffprobe");
  }
  return ffmpeg && ffprobe ? { ffmpeg, ffprobe } : null;
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// ────────────────────────────── arg parsing ──────────────────────────────

export type ParsedArgs = {
  command: string;
  bools: Set<string>;
  values: Record<string, string>;
};

/**
 * Parse a declared flag table: each command declares its permitted flags
 * (bool | value). An unknown flag or a missing value causes a UsageError
 * (main converts it to exit code 2).
 */
export function parseArgv(
  command: string,
  argv: string[],
  allowed: Record<string, "bool" | "value">,
): ParsedArgs {
  const bools = new Set<string>();
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--help" || a === "-h") {
      bools.add("--help");
      continue;
    }
    const kind = allowed[a];
    if (kind === undefined) throw new UsageError(`unknown flag \`${a}\``);
    if (kind === "bool") {
      bools.add(a);
      continue;
    }
    const v = argv[++i];
    if (v === undefined) throw new UsageError(`${a} needs a value`);
    if (v.startsWith("--")) throw new UsageError(`${a} needs a value — got the flag \`${v}\` instead`);
    values[a] = v;
  }
  return { command, bools, values };
}

// ─────────────────────────── crop utils (pure) ───────────────────────────
// Coordinate discipline (guardrail #5): this is the ONLY place that does
// crop geometry. All other code must call these functions.

/** yuv420p accepts even numbers only. Round down to even, minimum 2 px. */
export function evenAligned(r: Crop): Crop {
  return { x: r.x & ~1, y: r.y & ~1, w: Math.max(2, r.w & ~1), h: Math.max(2, r.h & ~1) };
}

/** Convert "--crop x:y:w:h" to an even-aligned Crop. An incorrect format causes a UsageError. */
export function parseCropSpec(spec: string): Crop {
  const parts = spec.split(":").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((n) => !Number.isInteger(n)) ||
    (parts[2] as number) <= 0 ||
    (parts[3] as number) <= 0
  ) {
    throw new UsageError("--crop must have the format x:y:w:h (integer numbers, pixels; w and h must be > 0)");
  }
  return evenAligned({
    x: parts[0] as number,
    y: parts[1] as number,
    w: parts[2] as number,
    h: parts[3] as number,
  });
}

/** Clamp the crop to the limits of the real capture frame (dimensions from
 *  the probe). This prevents a 1-2 px error between the calculation and the
 *  avfoundation frame. The result is even-aligned. */
export function clampCrop(r: Crop, captureWidth: number, captureHeight: number): Crop {
  const x = Math.max(0, Math.min(r.x, Math.max(0, captureWidth - 2)));
  const y = Math.max(0, Math.min(r.y, Math.max(0, captureHeight - 2)));
  const w = Math.max(2, Math.min(r.w, captureWidth - x));
  const h = Math.max(2, Math.min(r.h, captureHeight - y));
  return evenAligned({ x, y, w, h });
}

/** Pure: did the clamp change the requested area? Agents get this as
 *  `cropClamped` in the JSON — a silently moved crop used to surface later
 *  as an encoder error instead of a coordinate error. */
export function cropWasClamped(requested: Crop, applied: Crop): boolean {
  return (
    requested.x !== applied.x ||
    requested.y !== applied.y ||
    requested.w !== applied.w ||
    requested.h !== applied.h
  );
}

/** Pure: is the crop too small to be anything but a coordinate bug? The
 *  floor is the output, not the crop: 16 px of input at half scale (8 px out),
 *  8 px at full resolution (the default). Below it libx264 either refuses the
 *  frame or writes a smear, so `record` stops at the boundary with a usage
 *  error instead. */
export function cropUnusable(c: Crop, downscale: boolean): boolean {
  const min = downscale ? 16 : 8;
  return c.w < min || c.h < min;
}

/** Pure: resolve the encode mode from the record flags. Since 0.2.0 full
 *  resolution is the default; `--half` opts into the 50% scale; `--small`
 *  is CRF 28 + half scale; and `--full-res` — kept so pre-0.2.0 commands
 *  keep their exact meaning — overrides the half scale of `--half` and
 *  `--small` (CRF 28 still applies). */
export function resolveEncodeMode(
  flags: { fullRes: boolean; half: boolean; small: boolean },
): { downscale: boolean; crf: number } {
  return {
    downscale: flags.fullRes ? false : flags.half || flags.small,
    crf: flags.small ? 28 : 26,
  };
}

// ───────────────────────────── timestamp ─────────────────────────────────

/**
 * Make an ASCII-safe timestamp for file names. Do not use toLocaleString.
 * Apple locale output contains a U+202F narrow space that breaks file names
 * (real defect found earlier).
 */
export function asciiTimestamp(d: Date = new Date()): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
  );
}

// ─────────────────────── output helper (--json contract) ─────────────────

type Parsed2 = { bools: Set<string> };

function emitJsonOr(p: Parsed2, humanLine: string, payload: Record<string, unknown>): void {
  if (p.bools.has("--json")) process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  else process.stdout.write(humanLine + "\n");
}

// ───────────────────── screen probe (port ScreenProbe.swift) ─────────────
// Runtime discovery (guardrail #6): the avfoundation device mapping changes
// between sessions. Never make the index permanent in the code.

/** Parse the output of `ffmpeg -f avfoundation -list_devices true -i ""`.
 *  Pure function — unit tested with a fixture. Keep only names that start
 *  with `Capture screen`. A probe of the face camera stops and waits for a
 *  permission that never comes (real defect, pitfall #3). The list command
 *  exits with code 251; this is normal. Trust the output only. */
export function parseDeviceList(raw: string): { screens: ScreenDevice[]; mics: MicDevice[] } {
  const screens: ScreenDevice[] = [];
  const mics: MicDevice[] = [];
  let inAudio = false;
  const re = /\[AVFoundation[^\]]*\] \[(\d+)\] (.+)$/;
  for (const line of raw.split("\n")) {
    if (line.includes("audio devices")) {
      inAudio = true;
      continue;
    }
    const m = re.exec(line);
    if (!m) continue;
    const idx = Number(m[1]);
    const name = (m[2] ?? "").trim();
    if (inAudio) {
      mics.push({ index: idx, name });
    } else if (name.startsWith("Capture screen")) {
      screens.push({ index: idx, name, width: null, height: null });
    }
  }
  return { screens, mics };
}

/** Run list_devices. Kill with SIGKILL after a 10 s timeout (guardrail #4
 *  + P5: ffmpeg blocked in avfoundation-init does not obey SIGTERM). */
export function listDevices(t: Toolchain): { screens: ScreenDevice[]; mics: MicDevice[] } {
  const r = spawnSync(t.ffmpeg, ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""], {
    timeout: 10_000,
    killSignal: "SIGKILL",
    encoding: "utf8",
  });
  const raw = (r.stdout ?? "") + (r.stderr ?? ""); // avfoundation prints the devices to stderr
  if (!raw.includes("AVFoundation")) throw new RunError(`Cannot list the avfoundation devices (rc=${r.status}): ${raw.slice(0, 300)}`);
  return parseDeviceList(raw);
}

/** Get the dimensions of a file with ffprobe (csv "w,h"). Return null when ffprobe cannot read them. */
export function ffprobeDims(t: Toolchain, file: string): { w: number; h: number } | null {
  const r = spawnSync(
    t.ffprobe,
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file],
    { timeout: 10_000, killSignal: "SIGKILL", encoding: "utf8" },
  );
  const s = (r.stdout ?? "").trim();
  const parts = s.split(",").map(Number);
  if (parts.length !== 2 || parts.some((n) => !Number.isInteger(n) || n <= 0)) return null;
  return { w: parts[0] as number, h: parts[1] as number };
}

/** The one source of truth for the Screen Recording remedy. macOS attributes
 *  the grant (TCC) to the app that LAUNCHES the capture — never to ffmpeg —
 *  so every message that offers the remedy builds on this sentence. Messages
 *  used to drift (one of them told the user to check the permission "of
 *  ffmpeg"); a unit test and a `check.sh` gate now hold the line. */
export const TCC_REMEDY =
  "First make sure a display is active. A screen that is off, a closed lid, or a remote session" +
  " with no on-screen display gives the same empty screen list as a lost grant." +
  " macOS attributes the Screen Recording grant (TCC) to the app that RUNS the recording" +
  " (your terminal or agent host: Terminal, iTerm, ZCode, DeepSeek Harness), never to ffmpeg." +
  " Open System Settings → Privacy & Security → Screen Recording and toggle THAT app OFF and ON." +
  " Then fully quit and reopen THAT app: a running process re-reads the permission only at launch." +
  " Recent macOS versions drop the grant when a display is connected or disconnected.";

/** The reset-and-regrant sentence for a KNOWN bundle id of the host app.
 *  `tccutil reset ScreenCapture` without a bundle id wipes the grants of
 *  every app at once, so the command ships only when the id is known. */
export function tccutilLine(bundleId: string): string {
  return (
    `If the entry still will not stick, run \`tccutil reset ScreenCapture ${bundleId}\`,` +
    " reopen the app, and grant the permission again."
  );
}

/** Detect the signature of a lost Screen Recording permission (TCC): the
 *  capture hangs until the probe is killed (rc = null) or dies at once.
 *  Return a remedy hint, or "" for unrelated errors. `hostBundleId` (when
 *  known) adds the targeted tccutil command. */
export function tccHint(rc: number | null, stderr: string, hostBundleId?: string): string {
  const looksLikeTcc = rc === null || stderr.includes("not linked into application");
  if (!looksLikeTcc) return "";
  const reset = hostBundleId ? ` ${tccutilLine(hostBundleId)}` : "";
  return `Hint: a capture that hangs or dies at once is usually a lost Screen Recording permission. ${TCC_REMEDY}${reset}`;
}

/** Capture one frame from a device to get the real pixel dimensions
 *  (about 1-2 s). Kill with SIGKILL after a 12 s timeout. A probe must
 *  never block. */
export function probeDeviceDims(t: Toolchain, deviceIndex: number): { w: number; h: number } {
  const tmp = join(tmpdir(), `pomulum-probe-${process.pid}-${deviceIndex}.png`);
  try {
    const r = spawnSync(
      t.ffmpeg,
      [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "avfoundation", "-framerate", "30", "-pixel_format", "nv12",
        "-i", String(deviceIndex),
        "-frames:v", "1", "-update", "1", tmp,
      ],
      { timeout: 12_000, killSignal: "SIGKILL", encoding: "utf8" },
    );
    const dims = existsSync(tmp) ? ffprobeDims(t, tmp) : null;
    if (dims === null) {
      const stderr = (r.stderr ?? "").slice(0, 300);
      throw new RunError(
        `Cannot get the dimensions of device ${deviceIndex} (rc=${r.status}): ${stderr} ${tccHint(r.status, stderr, findHostAppBundleId())}`.trimEnd(),
      );
    }
    return dims;
  } finally {
    rmSync(tmp, { force: true }); // a probe must not leak PNGs
  }
}

// ───────────────────── disk cache dims (port 53c3d74 + TTL) ──────────────

const CACHE_DIR = join(homedir(), "Library", "Caches", "pomulum");
const CACHE_FILE = join(CACHE_DIR, "screen-cache.json");
const CACHE_TTL_MS = 3600_000; // 1 h. Dimensions change rarely; the device-list signature catches plug/unplug.

export type Dim = { w: number; h: number };
type ScreenCache = { version: 1; signature: string; ts: number; dims: Record<string, Dim> };

/** Cache key = the device list (index + name). When you connect or
 *  disconnect a display, the signature changes and the cache misses. When
 *  only the resolution changes, the TTL catches it. */
function devicesSignature(screens: ScreenDevice[], mics: MicDevice[]): string {
  return [...screens, ...mics].map((d) => `${d.index}:${d.name}`).join("|");
}

/** Pure: which screens still need a one-frame probe? The cache stores one
 *  entry per device, and `record` writes only the device it selected — a hit
 *  on the signature is NOT a promise that every device is in the map. A
 *  missing entry must be probed, never reported as `width: null` (the 0.1.1
 *  defect: `screens` after a single-device `record` on a cold cache). */
export function screensNeedingProbe(screens: ScreenDevice[], dims: Record<string, Dim>): ScreenDevice[] {
  return screens.filter((s) => dims[String(s.index)] === undefined);
}

function readCache(signature: string): Record<string, Dim> | null {
  try {
    const c = JSON.parse(readFileSync(CACHE_FILE, "utf8")) as ScreenCache;
    if (c.version !== 1 || c.signature !== signature) return null;
    if (Date.now() - c.ts > CACHE_TTL_MS) return null;
    return c.dims;
  } catch {
    return null;
  }
}

function writeCache(signature: string, dims: Record<string, Dim>): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const c: ScreenCache = { version: 1, signature, ts: Date.now(), dims };
    writeFileSync(CACHE_FILE, JSON.stringify(c, null, 2));
  } catch {
    // The cache is best-effort. A disk error must not break the main command.
  }
}

// ─────────────────────────────── commands ────────────────────────────────

const SCREENS_FLAGS: Record<string, "bool" | "value"> = {
  "--json": "bool",
  "--no-cache": "bool",
};
const SNAP_FLAGS: Record<string, "bool" | "value"> = {
  "--json": "bool",
  "--out": "value",
  "--screen": "value",
};
const RECORD_FLAGS: Record<string, "bool" | "value"> = {
  "--json": "bool",
  "--crop": "value",
  "--screen": "value",
  "--duration": "value",
  "--max-duration": "value",
  "--out": "value",
  "--no-mic": "bool",
  "--half": "bool",
  "--full-res": "bool",
  "--small": "bool",
  "--dry-run": "bool",
};
const STOP_FLAGS: Record<string, "bool" | "value"> = { "--json": "bool" };
const STATUS_FLAGS: Record<string, "bool" | "value"> = { "--json": "bool" };

/** Default time limit for record without --duration. An agent can stop
 *  in the middle of a task; ffmpeg must not fill the disk. Set
 *  `--max-duration 0` to remove the limit. */
export const DEFAULT_MAX_DURATION_SEC = 1800; // 30 minutes

/** Pure: calculate the final `-t`. The --duration value wins. Without it,
 *  use the max-duration limit (default 30 minutes; 0 = no limit). */
export function effectiveDurationCap(
  durationSec: number | null,
  maxDurationSec: number | null,
): number | null {
  if (durationSec !== null) return durationSec;
  if (maxDurationSec === null) return DEFAULT_MAX_DURATION_SEC;
  return maxDurationSec > 0 ? maxDurationSec : null;
}

function parsePositiveNumber(flag: string, v: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new UsageError(`${flag} must be a number >= 0`);
  return n;
}

/** Why `screens` found no screen. avfoundation lists microphones without a
 *  grant, so a healthy enumeration with zero screens points at the Screen
 *  Recording gate: the grant is missing, or the host app has not been
 *  relaunched since it was granted. "no-devices" means the enumeration
 *  itself came back empty and the cause is elsewhere. */
export type ScreenPermission = "ok" | "blocked" | "no-devices";

/** Pure: classify the `screens` result. */
export function resolveScreenPermission(
  screens: readonly unknown[],
  mics: readonly unknown[],
): ScreenPermission {
  if (screens.length > 0) return "ok";
  if (mics.length > 0) return "blocked";
  return "no-devices";
}

/** Pure: the bundle root of an app-bundle executable path, or null.
 *  "/Applications/Host.app/Contents/MacOS/Host" → "/Applications/Host.app". */
export function appBundleRoot(execPath: string): string | null {
  const m = execPath.match(/^(\/.*)\.app\/Contents\/MacOS\//);
  return m ? `${m[1]}.app` : null;
}

/** Walk the parent chain to the app bundle that hosts this process and read
 *  its bundle id — the TCC "responsible process" that owns the grant. Any
 *  failure returns undefined, and the remedy hint stays generic. Both
 *  helpers run by absolute path (no shell). */
export function findHostAppBundleId(maxHops = 12): string | undefined {
  try {
    let pid = process.ppid;
    for (let i = 0; pid > 1 && i < maxHops; i++) {
      const ps = spawnSync("/usr/bin/ps", ["-o", "ppid=", "-o", "comm=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: 3000,
      });
      const line = (ps.stdout ?? "").trim();
      if (!line) return undefined;
      const split = line.indexOf(" ");
      const ppid = Number.parseInt(line.slice(0, split), 10);
      const comm = line.slice(split + 1).trim();
      const root = appBundleRoot(comm);
      if (root !== null) {
        const pl = spawnSync(
          "/usr/bin/plutil",
          ["-extract", "CFBundleIdentifier", "raw", join(root, "Contents", "Info.plist")],
          { encoding: "utf8", timeout: 3000 },
        );
        const id = (pl.stdout ?? "").trim();
        return id.length > 0 ? id : undefined;
      }
      if (!Number.isFinite(ppid) || ppid <= 1) return undefined;
      pid = ppid;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** `screens [--json] [--no-cache]` — list the avfoundation screens and
 *  microphones with their real pixel dimensions (one-frame probe, with a
 *  disk cache). */
function cmdScreens(argv: string[]): number {
  const a = parseArgv("screens", argv, SCREENS_FLAGS);
  if (a.bools.has("--help")) {
    process.stdout.write("pomulum screens [--json] [--no-cache]\n");
    return 0;
  }
  const t = requireToolchain();
  const t0 = performance.now();
  const { screens, mics } = listDevices(t);
  const permission = resolveScreenPermission(screens, mics);
  const hostBundleId = permission === "ok" ? undefined : findHostAppBundleId();
  const hint =
    permission === "ok" ? undefined : `${TCC_REMEDY}${hostBundleId ? ` ${tccutilLine(hostBundleId)}` : ""}`;
  const signature = devicesSignature(screens, mics);
  const noCache = a.bools.has("--no-cache");
  const cached = noCache ? null : readCache(signature);

  const dims: Record<string, Dim> = cached ? { ...cached } : {};
  // A cache hit covers only the devices the map actually stores (`record`
  // writes one device at a time) — probe the rest instead of reporting null,
  // and write the completed map back.
  const missing = screensNeedingProbe(screens, dims);
  for (const s of missing) dims[String(s.index)] = probeDeviceDims(t, s.index);
  if (!noCache && missing.length > 0) writeCache(signature, dims);
  const fromCache = cached !== null && missing.length === 0;
  for (const s of screens) {
    const d = dims[String(s.index)];
    s.width = d ? d.w : null;
    s.height = d ? d.h : null;
  }
  const elapsedMs = Math.round(performance.now() - t0);

  emitJsonOr(
    a,
    [
      `Capture devices (avfoundation):`,
      ...screens.map((s) => `  [${s.index}] ${s.name} — ${s.width}×${s.height}${fromCache ? " (cache)" : ""}`),
      `Mic:`,
      ...mics.map((m) => `  [${m.index}] ${m.name}`),
      ...(hint ? ["", `Screen permission: ${permission}.`, `Hint: ${hint}`] : []),
      ``,
      `Use: node pomulum.ts record --screen <index> [--crop x:y:w:h]`,
    ].join("\n"),
    {
      screens,
      mics,
      screenPermission: permission,
      ...(hint ? { hint } : {}),
      cached: fromCache,
      elapsedMs,
    },
  );
  return 0;
}

function requireToolchain(): Toolchain {
  const t = locateToolchain();
  if (!t) throw new RunError("Cannot find ffmpeg/ffprobe. Install them with: brew install ffmpeg");
  return t;
}

/** Pre-flight the output directory. The default output lives in ~/Desktop,
 *  which macOS guards with the "Files and Folders" permission — a denied
 *  write kills ffmpeg about one second in, with a log that reads like a
 *  lost Screen Recording grant. Fail early with a clear message instead.
 *  A folder that does not exist and a folder that is denied are different
 *  problems, so they get different messages (a missing ~/Desktop used to
 *  read as a permission error, sending the user to the wrong pane). */
export function requireWritableDir(file: string): void {
  const dir = dirname(file);
  try {
    accessSync(dir, constants.W_OK);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new RunError(
        `The output directory ${dir} does not exist. Create it, or pass --out with an existing ` +
          `directory, for example /tmp/${basename(file)}`,
      );
    }
    throw new RunError(
      `Cannot write to ${dir} — macOS may deny this folder (Files & Folders permission). ` +
        `Pass --out with a writable path, for example /tmp/${basename(file)}`,
    );
  }
}

// ─────────────────────── shared device selection ────────────────────────

/** Pure: select the capture device for `--screen N` (an avfoundation index
 *  from `screens`). Default = the first screen. Usage/RunError messages are
 *  clear for agents. */
export function selectScreen(screens: ScreenDevice[], screenFlag: string | undefined): ScreenDevice {
  if (screens.length === 0)
    throw new RunError(
      `No capture device found. Connect a display — if one is already connected, ${TCC_REMEDY}`,
    );
  if (screenFlag !== undefined) {
    const idx = Number(screenFlag);
    if (!Number.isInteger(idx) || idx < 0) throw new UsageError("--screen must be an integer >= 0");
    const dev = screens.find((s) => s.index === idx);
    if (!dev) {
      throw new UsageError(
        `--screen ${idx}: no device has index ${idx}. Available devices: ` +
          screens.map((s) => `[${s.index}] ${s.name}`).join(", "),
      );
    }
    return dev;
  }
  return screens[0] as ScreenDevice;
}

/** List the devices once, then select the screen (the snap path). */
function resolveScreenDevice(t: Toolchain, screenFlag: string | undefined): ScreenDevice {
  const { screens } = listDevices(t);
  return selectScreen(screens, screenFlag);
}

/** Get the dimensions of a device. Read the cache first (M2), then probe on
 *  a miss. `signature` comes from the same listDevices run that selected
 *  the device — this function does not list the devices again. With
 *  `persist = false` (a dry run) it reads and probes but writes nothing:
 *  a dry run has no disk side effects. */
function deviceDims(t: Toolchain, dev: ScreenDevice, signature: string, persist = true): Dim {
  const cached = readCache(signature);
  const hit = cached?.[String(dev.index)];
  if (hit) return hit;
  const d = probeDeviceDims(t, dev.index);
  if (persist) writeCache(signature, { ...(cached ?? {}), [String(dev.index)]: d }); // also on a cold miss,
  return d; // so the next record does not probe again
}

/** `snap [--out F] [--screen N]` — capture one native-resolution PNG frame
 *  from a device. This is the "eye" of the agent: it reads the snap to
 *  select the crop. The pixel coordinates of the snap equal the pixel
 *  coordinates of the record capture frame (proven by the M3 benchmark).
 *  There is NO coordinate conversion step (guardrail #5). */
function cmdSnap(argv: string[]): number {
  const a = parseArgv("snap", argv, SNAP_FLAGS);
  if (a.bools.has("--help")) {
    process.stdout.write("pomulum snap [--out F.png] [--screen N] [--json]\n");
    return 0;
  }
  const t = requireToolchain();
  const t0 = performance.now();
  const dev = resolveScreenDevice(t, a.values["--screen"]);
  const out = a.values["--out"] ?? join(tmpdir(), `pomulum-snap-${asciiTimestamp()}.png`);
  requireWritableDir(out);
  const r = spawnSync(
    t.ffmpeg,
    [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "avfoundation", "-framerate", "30", "-pixel_format", "nv12",
      "-capture_cursor", "1",
      "-i", String(dev.index),
      "-frames:v", "1", "-update", "1", out,
    ],
    { timeout: 12_000, killSignal: "SIGKILL", encoding: "utf8" },
  );
  // Trust only a clean ffmpeg exit: a pre-existing file must never be
  // reported as THIS run's success (e.g. an old image after the TCC grant
  // was lost).
  const dims = r.status === 0 && existsSync(out) ? ffprobeDims(t, out) : null;
  if (dims === null) {
    const stderr = (r.stderr ?? "").slice(0, 300);
    throw new RunError(`Snap failed (rc=${r.status}): ${stderr} ${tccHint(r.status, stderr, findHostAppBundleId())}`.trimEnd());
  }
  const elapsedMs = Math.round(performance.now() - t0);
  emitJsonOr(
    a,
    `Snap: ${out} — ${dims.w}×${dims.h} (device [${dev.index}] ${dev.name}, ${elapsedMs}ms)`,
    {
      out,
      device: { index: dev.index, name: dev.name },
      width: dims.w,
      height: dims.h,
      elapsedMs,
    },
  );
  return 0;
}

// ─────────────── encode config (port EncodeConfig.swift) ─────────────────

export type EncodeOpts = {
  videoDevice: number;
  micDevice: number | null; // null = -an
  crop: Crop | null;
  downscale: boolean; // true = the optional 50% scale (--half; full resolution is the default since 0.2.0)
  crf: number; // 26 sweet spot, 28 = --small
  preset: string;
  framerate: number;
  durationSec: number | null; // -t N as an output option
};

/** Input spec "V:A". To record a microphone, combine "video:audio". When
 *  you set -c:a but the input has video only, the file has no sound (old
 *  sweet-spot defect in the README). */
export function inputSpec(o: EncodeOpts): string {
  return o.micDevice !== null ? `${o.videoDevice}:${o.micDevice}` : String(o.videoDevice);
}

/** The half-scale expression, in ffmpeg filter syntax. One constant, because
 *  two places must agree: the filter that scales the frame, and
 *  `scaledDims()` that promises the caller what size the file will be. A unit
 *  test ties them together.
 *
 *  Why not `scale=iw/2:-2`: that only guards the height. A crop 18 px wide
 *  asked for a 9 px frame, and libx264 cannot open yuv420p at an odd width —
 *  the recording died with "Could not open encoder before EOF" (real defect,
 *  found before the first release). Flooring each axis to an even size costs at
 *  pixel per axis and keeps the promise exact. */
export const HALF_SCALE_FILTER = "scale=trunc(iw/4)*2:trunc(ih/4)*2";

export function videoFilter(o: EncodeOpts): string | null {
  const parts: string[] = [];
  if (o.crop) parts.push(`crop=${o.crop.w}:${o.crop.h}:${o.crop.x}:${o.crop.y}`);
  if (o.downscale) parts.push(HALF_SCALE_FILTER);
  return parts.length ? parts.join(",") : null;
}

/** Pure: the encoded frame size for a crop (or the full frame). Mirrors
 *  HALF_SCALE_FILTER — floor each axis to the nearest even number of
 *  half-pixels. Must stay in step with videoFilter(). */
export function scaledDims(w: number, h: number, downscale: boolean): Dim {
  if (!downscale) return { w, h };
  return { w: Math.trunc(w / 4) * 2, h: Math.trunc(h / 4) * 2 };
}

/** ffmpeg arguments — the encode sweet spot (docs/BENCHMARK.md): libx264
 *  veryfast CRF 26, yuv420p, aac 96k, +faststart. Pure function — tested
 *  with golden tests. */
export function buildFfmpegArgs(o: EncodeOpts, output: string): string[] {
  const a = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "avfoundation",
    "-framerate", String(o.framerate),
    "-pixel_format", "nv12", // ffmpeg 8: without it the avfoundation input blocks forever
    "-capture_cursor", "1",
    "-i", inputSpec(o),
  ];
  const vf = videoFilter(o);
  if (vf) a.push("-vf", vf);
  a.push("-c:v", "libx264", "-preset", o.preset, "-crf", String(o.crf), "-pix_fmt", "yuv420p");
  if (o.micDevice !== null) a.push("-c:a", "aac", "-b:a", "96k");
  else a.push("-an");
  a.push("-movflags", "+faststart");
  a.push("-metadata", "comment=pomulum-recording"); // inert marker: makes our recorder recognizable in `ps`
  if (o.durationSec !== null) a.push("-t", String(o.durationSec));
  a.push(output);
  return a;
}

// ─────────────── record/stop model: pidfile + detached ───────────────────

const PIDFILE = "/tmp/pomulum-rec.pid";
const FFMPEG_LOG = "/tmp/pomulum-ffmpeg.log";

/** The pidfile holds exactly one of two shapes. "ended" is never stored — it
 *  is derived (a recording whose pid is gone). There are no optional fields:
 *  an illegal state must not be representable. */
export type PendingState = {
  state: "pending"; // claimed, but no ffmpeg spawned yet (or the start died)
  output: string;
  startedAt: string; // ISO
};

export type RecordingState = {
  state: "recording";
  pid: number; // the spawned pid execs ffmpeg and becomes the process-group
  // leader (the detached spawn calls setsid; macOS caffeinate forks a
  // supervisor CHILD inside that group). `stop` polls THIS pid.
  output: string;
  command: string;
  startedAt: string; // ISO
  device: { index: number; name: string; width: number; height: number };
  crop: Crop | null;
  mic: number | null;
  capSec: number | null; // the -t limit ffmpeg stops at on its own; null = none
};

export type RecordState = PendingState | RecordingState;

/** Parse pidfile JSON into a known state. Pure — this is the test surface for
 *  the pidfile format. Anything else throws: a corrupt file and an
 *  unrecognized shape must not look like "no recording". */
export function parsePidfile(raw: string): RecordState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RunError(`The pidfile ${PIDFILE} is corrupt (not JSON). Remove it with: rm ${PIDFILE}`);
  }
  const bad = (): never => {
    throw new RunError(`The pidfile ${PIDFILE} has an unrecognized shape. Remove it with: rm ${PIDFILE}`);
  };
  if (typeof parsed !== "object" || parsed === null) bad();
  const o = parsed as Record<string, unknown>;
  const hasBase =
    typeof o.output === "string" &&
    typeof o.startedAt === "string" &&
    Number.isFinite(Date.parse(o.startedAt));
  if (o.state === "pending" && hasBase) {
    return { state: "pending", output: o.output as string, startedAt: o.startedAt as string };
  }
  const dev = o.device as Record<string, unknown> | undefined;
  if (
    o.state === "recording" &&
    hasBase &&
    typeof o.pid === "number" &&
    Number.isInteger(o.pid) &&
    o.pid > 0 &&
    typeof o.command === "string" &&
    typeof dev === "object" &&
    dev !== null &&
    typeof dev.index === "number" &&
    typeof dev.name === "string"
  ) {
    return {
      state: "recording",
      pid: o.pid,
      output: o.output as string,
      startedAt: o.startedAt as string,
      command: o.command,
      device: {
        index: dev.index,
        name: dev.name,
        width: typeof dev.width === "number" ? dev.width : 0,
        height: typeof dev.height === "number" ? dev.height : 0,
      },
      crop: (o.crop ?? null) as Crop | null,
      mic: typeof o.mic === "number" ? o.mic : null,
      capSec: typeof o.capSec === "number" && o.capSec > 0 ? o.capSec : null,
    };
  }
  return bad();
}

/** Read the pidfile. null = no pidfile (ENOENT). A corrupt or unrecognized
 *  file is a distinct runtime error — a missing file and a broken file must
 *  not look the same to the agent. */
export function readPidfile(): RecordState | null {
  let raw: string;
  try {
    raw = readFileSync(PIDFILE, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new RunError(`Cannot read the pidfile ${PIDFILE}: ${(e as Error).message}`);
  }
  return parsePidfile(raw);
}

/** Create the pending claim exclusively (the "wx" flag = O_EXCL). False when
 *  it already exists — the caller then decides between a live recording
 *  (error) and a stale file (remove and claim again). This closes the
 *  check-then-write race between two concurrent `record` calls. */
export function claimPidfile(state: PendingState): boolean {
  try {
    writeFileSync(PIDFILE, JSON.stringify(state, null, 2), { flag: "wx", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** Create a runtime file safely in a world-writable directory. A leftover
 *  entry — for example a symlink planted in /tmp — must never redirect our
 *  write: remove it first, then create the file with O_EXCL and mode 0600
 *  (CWE-59 link following / CWE-377 insecure temp file). */
function createRuntimeFile(path: string): number {
  rmSync(path, { force: true });
  return openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
}

/** Replace the pidfile with the live state. Same discipline as the claim:
 *  never follow a leftover symlink, keep the file private. Throws on
 *  failure — the caller must then fail closed and kill the recording. */
function writePidfile(state: RecordingState): void {
  rmSync(PIDFILE, { force: true });
  writeFileSync(PIDFILE, JSON.stringify(state, null, 2), { flag: "wx", mode: 0o600 });
}

/** Is the pid alive? (EPERM = alive, but not our process.) Guards against
 *  pid <= 0: kill(0) would signal the caller's whole process group, and a
 *  negative pid means "every process we may signal" — never use them. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Pure: does a command line look like a pomulum recorder? The recorder is
 *  identified by TWO markers: the avfoundation capture AND the inert
 *  `-metadata comment=pomulum-recording` argument (see buildFfmpegArgs). A
 *  foreign avfoundation capture — or pomulum's own short-lived snap/screens
 *  probe — must not match. `stop` must never signal a process group it
 *  cannot positively identify. */
export function looksLikeOurRecorder(commandLine: string): boolean {
  return commandLine.includes("avfoundation") && commandLine.includes("pomulum-recording");
}

/** Is this pid almost certainly a pomulum recording? This protects against a stale pidfile and a re-used pid. */
export function pidIsOurs(pid: number): boolean {
  const r = spawnSync("/bin/ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 3000 });
  return looksLikeOurRecorder((r.stdout ?? "").trim());
}

/** Synchronous sleep for this single-threaded CLI. Atomics.wait is the standard node sleep. */
function nap(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForExit(pid: number, ms: number): boolean {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    nap(100);
  }
  return !pidAlive(pid);
}

function logTail(n = 500): string {
  try {
    const s = readFileSync(FFMPEG_LOG, "utf8").trim();
    return s.slice(-n);
  } catch {
    return "(log is empty)";
  }
}

/** Size of a file, 0 when it does not exist yet. */
function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Is the output still growing? A growing file means ffmpeg is finalizing
 *  (the +faststart moov rewrite scales with the file size), not stuck — a
 *  SIGKILL there would truncate the trailer and leave an unprobeable file. */
function stillGrowing(path: string): boolean {
  const before = fileSize(path);
  nap(400);
  return fileSize(path) > before;
}

/**
 * Stop a recording. Send SIGINT to the full process group (caffeinate
 * supervisor + ffmpeg). ffmpeg then ends by itself and writes the moov atom
 * (+faststart needs the trailer). Wait 8 s for SIGINT, then escalate to
 * SIGTERM (wait 3 s) and finally SIGKILL (wait 2 s) — P5: ffmpeg blocked in
 * avfoundation-init ignores SIGTERM; SIGKILL is final. ffmpeg exits with
 * rc=255 on SIGINT. This is normal. The caller verifies the result with
 * ffprobe.
 *
 * Before SIGKILL the escalation asks for EVIDENCE that the process is stuck:
 * while the output file keeps growing (up to 5 more seconds) ffmpeg is
 * treated as finalizing and gets the time. Only a stable file means it is
 * wedged, and only then is SIGKILL the right tool.
 *
 * `signaled` is false when nothing was signalled (the pid had already
 * exited — labelled "already-exited" because "natural duration end" and
 * "crash" cannot be distinguished here) or when every kill failed (e.g.
 * EPERM on a foreign-user pidfile in sticky /tmp) — the caller must then
 * keep the pidfile instead of assuming the recording is gone.
 */
export function stopRecording(state: RecordingState): {
  stoppedBy: "already-exited" | "SIGINT" | "SIGTERM" | "SIGKILL" | "stale";
  signaled: boolean;
} {
  if (!pidAlive(state.pid)) return { stoppedBy: "already-exited", signaled: false };
  if (!pidIsOurs(state.pid)) return { stoppedBy: "stale", signaled: false };
  let signalError: Error | null = null;
  const killGroup = (sig: NodeJS.Signals): void => {
    try {
      process.kill(-state.pid, sig); // a negative pid = the full process group
    } catch (e) {
      signalError = e as Error;
    }
  };
  killGroup("SIGINT");
  if (waitForExit(state.pid, 8_000)) return { stoppedBy: "SIGINT", signaled: true };
  killGroup("SIGTERM");
  if (waitForExit(state.pid, 3_000)) return { stoppedBy: "SIGTERM", signaled: true };
  for (let i = 0; i < 5 && stillGrowing(state.output); i++) {
    if (waitForExit(state.pid, 1_000)) return { stoppedBy: "SIGTERM", signaled: true };
  }
  killGroup("SIGKILL");
  waitForExit(state.pid, 2_000);
  return { stoppedBy: "SIGKILL", signaled: signalError === null };
}

// ─────────────── artifact verification (port of OutputVerifier.swift) ────
// Guardrail #7: do NOT trust the exit code. Trust ffprobe only.

export type RecordingInfo = {
  width: number;
  height: number;
  durationSeconds: number;
  bytes: number;
  hasAudio: boolean;
};

export function ffprobeVerify(t: Toolchain, file: string): RecordingInfo | null {
  const r = spawnSync(
    t.ffprobe,
    ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file],
    { timeout: 15_000, killSignal: "SIGKILL", encoding: "utf8" },
  );
  let j: { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> };
  try {
    j = JSON.parse(r.stdout ?? "");
  } catch {
    return null;
  }
  const streams = j.streams;
  if (!Array.isArray(streams)) return null;
  const v = streams.find((s) => s.codec_type === "video");
  if (!v || typeof v.width !== "number" || typeof v.height !== "number") return null;
  const hasAudio = streams.some((s) => s.codec_type === "audio");
  const fmtDur = Number((j.format as { duration?: string } | undefined)?.duration);
  const streamDur = Number(v.duration);
  const durationSeconds = Number.isFinite(fmtDur) && fmtDur > 0 ? fmtDur : Number.isFinite(streamDur) ? streamDur : 0;
  let bytes = 0;
  try {
    bytes = statSync(file).size;
  } catch {
    /* no file -> bytes = 0; the caller concludes that it failed */
  }
  return { width: v.width, height: v.height, durationSeconds, bytes, hasAudio };
}

// ─────────── capture verdict: did the file get what the agent asked? ──────
// A readable file is not enough. avfoundation can stop delivering frames and
// ffmpeg then exits cleanly with a short, valid mp4 (seen live: a 3 s request
// that produced 0.63 s). The agent must not learn that from a video player.

/** Allowance when the expectation is the `-t` cap: ffmpeg counts output
 *  time, so a reached cap is exact to a frame. */
export const SHORTFALL_ALLOWANCE_CAP_SEC = 1.0;
/** Allowance when the expectation is the wall clock: the spawn, the
 *  avfoundation warm-up and the SIGINT flush all sit outside the frames. */
export const SHORTFALL_ALLOWANCE_WALL_SEC = 2.5;

export type CaptureExpectation = { expectedSec: number; allowanceSec: number };
export type CaptureVerdict = { expectedSec: number; shortfallSec: number; short: boolean };

/** What `stop` expects the file to hold. The cap, when the wall clock shows
 *  ffmpeg reached it, or when ffmpeg ended on its own before it: nothing but
 *  a stall or a crash ends a capped capture early, so the request is still
 *  the measure. Else the wall clock up to the stop request, which is what
 *  the agent waited (a stop by hand before the cap is not a defect). */
export function expectedCapture(capSec: number | null, wallSec: number, selfExited: boolean): CaptureExpectation {
  if (capSec !== null && (wallSec >= capSec || selfExited)) {
    return { expectedSec: capSec, allowanceSec: SHORTFALL_ALLOWANCE_CAP_SEC };
  }
  return { expectedSec: Math.max(0, wallSec), allowanceSec: SHORTFALL_ALLOWANCE_WALL_SEC };
}

/** Short when the shortfall is over BOTH the allowance and 20 % of the
 *  expectation: a 1 s request keeps its warm-up, a 60 s request tolerates
 *  12 s, and 0.63 s out of 3 s is short. */
export function captureVerdict(actualSec: number, exp: CaptureExpectation): CaptureVerdict {
  const shortfallSec = Math.max(0, exp.expectedSec - actualSec);
  const short = shortfallSec > Math.max(exp.allowanceSec, 0.2 * exp.expectedSec);
  return { expectedSec: Math.round(exp.expectedSec * 10) / 10, shortfallSec: Math.round(shortfallSec * 10) / 10, short };
}

/** Facts the file is usable without, but the agent asked for. The list is
 *  always present in the stop payload (empty = nothing to report). */
export function stopWarnings(mic: number | null, hasAudio: boolean): string[] {
  const w: string[] = [];
  if (mic !== null && !hasAudio) {
    w.push(`mic ${mic} was requested but the file has no audio track (the device delivered no samples)`);
  }
  return w;
}

// ──────────────────────────── record ─────────────────────────────────────

/** Quote that is safe for display (dry-run). Do not use it to execute a command. */
function shellQuote(s: string): string {
  return /[^A-Za-z0-9_\-:/.]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

function cmdRecord(argv: string[]): number {
  const a = parseArgv("record", argv, RECORD_FLAGS);
  if (a.bools.has("--help")) {
    process.stdout.write("pomulum record [--crop x:y:w:h] [--screen N] [--duration N]\n                     [--out F] [--no-mic] [--half] [--full-res] [--small] [--dry-run] [--json]\n");
    return 0;
  }
  const t = requireToolchain();
  const out = a.values["--out"] ?? join(homedir(), "Desktop", `pomulum-${asciiTimestamp()}.mp4`);

  // ── The pidfile claim comes FIRST, before any ffmpeg work. A concurrent
  // record then fails at the claim and never spawns anything — no orphaned
  // capture, no second writer on the same output file, no truncated log.
  // Crash-safety: a crash after the claim leaves a recoverable pidfile; a
  // crash before it cannot leak a process.
  let prev: RecordState | null = null;
  try {
    prev = readPidfile();
  } catch {
    rmSync(PIDFILE, { force: true }); // record is the recovery tool for a corrupt pidfile
  }
  if (prev) {
    if (prev.state === "pending") {
      const ageSec = (Date.now() - Date.parse(prev.startedAt)) / 1000;
      if (ageSec < 60) {
        throw new RunError(
          `Another record command is starting (pidfile pending for ${Math.round(ageSec)} s). Try again in a moment.`,
        );
      }
      rmSync(PIDFILE, { force: true }); // a start that died before its spawn — stale
    } else if (pidAlive(prev.pid) && pidIsOurs(prev.pid)) {
      throw new RunError(`A recording is in progress (pid ${prev.pid}, output ${prev.output}). Run \`stop\` first.`);
    } else {
      rmSync(PIDFILE, { force: true }); // stale pidfile (dead or foreign pid) — re-claim below
    }
  }
  const pending: PendingState = { state: "pending", output: out, startedAt: new Date().toISOString() };
  if (!claimPidfile(pending)) {
    // Lost the claim race (another starter appeared between the pre-check
    // and the claim). Never fall back to a plain write — that would drop
    // the exclusive-create discipline.
    const other = readPidfile();
    const otherLive =
      other !== null && (other.state === "pending" || (pidAlive(other.pid) && pidIsOurs(other.pid)));
    if (otherLive) {
      throw new RunError(`A recording is in progress (output ${other?.output}). Run \`stop\` first.`);
    }
    rmSync(PIDFILE, { force: true });
    if (!claimPidfile(pending)) {
      throw new RunError("Another record command claimed the pidfile at the same moment. Try again.");
    }
  }

  // Everything below runs only for the process that owns the claim. Any
  // throw before the real state is written releases the claim.
  let claimed = true;
  try {
    // One listDevices run feeds the screen selection, the cache signature,
    // and the microphone choice (perf rule #8: do not spawn ffmpeg twice).
    const { screens, mics } = listDevices(t);
    const dev = selectScreen(screens, a.values["--screen"]);
    const signature = devicesSignature(screens, mics);
    const dims = deviceDims(t, dev, signature, !a.bools.has("--dry-run"));

    // The crop is reported as the pair (requested, applied): a clamp that
    // moves or shrinks the area is a fact the caller must see, never a
    // silent correction. A crop the clamp cut below the usable floor is a
    // coordinate bug — fail here (exit 2) rather than one second later
    // inside libx264 ("Could not open encoder before EOF").
    const { downscale, crf } = resolveEncodeMode({
      fullRes: a.bools.has("--full-res"),
      half: a.bools.has("--half"),
      small: a.bools.has("--small"),
    });
    let requestedCrop: Crop | null = null;
    let crop: Crop | null = null;
    if (a.values["--crop"] !== undefined) {
      requestedCrop = parseCropSpec(a.values["--crop"]);
      crop = clampCrop(requestedCrop, dims.w, dims.h);
      if (cropUnusable(crop, downscale)) {
        throw new UsageError(
          `--crop ${a.values["--crop"]} leaves nothing to record on device [${dev.index}] ` +
            `${dev.name} (${dims.w}×${dims.h}): the largest area at that origin is ` +
            `${crop.w}×${crop.h}. Read the coordinates from a \`snap --screen ${dev.index}\`.`,
        );
      }
    }
    const cropClamped = requestedCrop !== null && crop !== null && cropWasClamped(requestedCrop, crop);
    const encoded = crop ? scaledDims(crop.w, crop.h, downscale) : scaledDims(dims.w, dims.h, downscale);
    const expectW = encoded.w;
    const expectH = encoded.h;
    const expectedDims = { w: expectW, h: expectH };

    const mic: number | null =
      !a.bools.has("--no-mic") && mics.length > 0 ? (mics[0] as MicDevice).index : null;

    let durationSec: number | null = null;
    if (a.values["--duration"] !== undefined) {
      durationSec = Number(a.values["--duration"]);
      if (!Number.isFinite(durationSec) || durationSec <= 0) throw new UsageError("--duration must be a number > 0");
    }
    let maxDurationSec: number | null = null;
    if (a.values["--max-duration"] !== undefined) {
      maxDurationSec = parsePositiveNumber("--max-duration", a.values["--max-duration"]);
    }
    const capSec = effectiveDurationCap(durationSec, maxDurationSec);

    const opts: EncodeOpts = {
      videoDevice: dev.index,
      micDevice: mic,
      crop,
      downscale,
      crf,
      preset: "veryfast",
      framerate: 30,
      durationSec: capSec,
    };
    const args = buildFfmpegArgs(opts, out);
    const commandLine = [t.ffmpeg, ...args].map(shellQuote).join(" ");

    if (a.bools.has("--dry-run")) {
      rmSync(PIDFILE, { force: true }); // a dry run owns no recording
      claimed = false;
      emitJsonOr(
        a,
        commandLine,
        {
          dryRun: true,
          started: false,
          command: commandLine,
          output: out,
          device: { index: dev.index, name: dev.name, width: dims.w, height: dims.h },
          crop,
          requestedCrop,
          cropClamped,
          expectedDims,
          mic,
          dims,
          durationSec,
          maxDurationSec,
          capSec,
          opts,
        },
      );
      return 0;
    }

    requireWritableDir(out);

    // Spawn detached under `caffeinate -i` to prevent App Nap (P7). The
    // detached child calls setsid and becomes the process-group leader (it
    // execs ffmpeg; macOS caffeinate forks a supervisor child inside that
    // group), so stop can signal the full group (-pid) and both processes
    // get the signal.
    const logFd = createRuntimeFile(FFMPEG_LOG);
    let child: ChildProcess;
    try {
      const stdio: ["ignore", number, number] = ["ignore", logFd, logFd];
      child =
        process.platform === "darwin"
          ? spawn("/usr/bin/caffeinate", ["-i", t.ffmpeg, ...args], { detached: true, stdio })
          : spawn(t.ffmpeg, args, { detached: true, stdio });
    } finally {
      closeSync(logFd); // the child holds its own copy of the fd; the parent can close it
    }
    child.unref();

    // Upgrade the claim to the real state IMMEDIATELY (before the liveness
    // wait): if this CLI dies during the wait, stop/status/record still see
    // the real pid and keep working.
    const childPid = child.pid;
    if (childPid === undefined) {
      rmSync(PIDFILE, { force: true });
      throw new RunError(`ffmpeg could not be spawned. Log: ${logTail()}`);
    }
    const state: RecordingState = {
      state: "recording",
      pid: childPid,
      output: out,
      command: commandLine,
      startedAt: new Date().toISOString(),
      device: { index: dev.index, name: dev.name, width: dims.w, height: dims.h },
      crop,
      mic,
      capSec,
    };
    try {
      writePidfile(state);
    } catch (e) {
      // The recording is live but untrackable — fail closed: kill it rather
      // than leave a capture that status/stop can never find.
      try {
        process.kill(-childPid, "SIGKILL");
      } catch {
        /* the group is already gone */
      }
      throw new RunError(
        `Cannot write the pidfile ${PIDFILE} (${(e as Error).message}). The recording was aborted.`,
      );
    }
    claimed = false; // a live recording exists now — the pidfile must survive any error below

    // Wait a moment to catch an immediate failure (broken device, lost TCC).
    nap(900);
    if (!pidAlive(childPid)) {
      const tail = logTail();
      rmSync(PIDFILE, { force: true }); // nothing is recording — do not leave a stale state
      throw new RunError(`ffmpeg stopped immediately after it started. Log: ${tail} ${tccHint(1, tail)}`.trimEnd());
    }

    emitJsonOr(
      a,
      [
        `● Recording → ${out}`,
        `  device [${dev.index}] ${dev.name} ${dims.w}×${dims.h}${crop ? ` · crop ${crop.x}:${crop.y}:${crop.w}:${crop.h}${cropClamped ? ` (clamped from ${requestedCrop?.x}:${requestedCrop?.y}:${requestedCrop?.w}:${requestedCrop?.h})` : ""}` : " · full screen"}`,
        `  estimated size ${expectW}×${expectH}${opts.downscale ? " (half scale)" : ""}${mic !== null ? " · mic" : " · no audio"}`,
        `  stop with: node pomulum.ts stop${capSec !== null ? ` (auto-stop after ${capSec}s${durationSec === null ? " — max-duration limit" : ""})` : " (no limit)"}`,
      ].join("\n"),
      {
        started: true,
        pid: state.pid,
        output: out,
        command: commandLine,
        device: state.device,
        crop,
        requestedCrop,
        cropClamped,
        mic,
        expectedDims,
        durationSec,
        maxDurationSec,
        capSec,
      },
    );
    return 0;
  } catch (e) {
    if (claimed) rmSync(PIDFILE, { force: true }); // release our own pending claim
    throw e;
  }
}

// ───────────────────────────── stop ──────────────────────────────────────

function cmdStop(argv: string[]): number {
  const a = parseArgv("stop", argv, STOP_FLAGS);
  if (a.bools.has("--help")) {
    process.stdout.write("pomulum stop [--json]\n");
    return 0;
  }
  const t = requireToolchain();
  const state = readPidfile();
  if (!state) throw new RunError("No recording is in progress (no pidfile /tmp/pomulum-rec.pid).");
  if (state.state === "pending") {
    const ageSec = Math.round((Date.now() - Date.parse(state.startedAt)) / 1000);
    rmSync(PIDFILE, { force: true }); // nothing was ever spawned — the claim is meaningless
    throw new RunError(
      ageSec < 60
        ? `A record command is still starting (pidfile pending for ${ageSec} s) — no recording to stop yet.`
        : `A record start went stale (pending for ${ageSec} s, no spawn happened) — pidfile removed, nothing to verify.`,
    );
  }

  // The wall clock ends at the stop request: the signal escalation and the
  // flush that follow add seconds, not frames.
  const stopRequestedAt = Date.now();
  const res = stopRecording(state);
  if (res.stoppedBy !== "already-exited" && res.stoppedBy !== "stale" && !res.signaled) {
    // Every kill attempt failed (e.g. a foreign-user pidfile in sticky
    // /tmp). Keep the pidfile — the recording may still be live.
    throw new RunError(
      `Cannot signal the process group of pid ${state.pid} (permission denied). The pidfile is kept — remove ${PIDFILE} manually only if you are sure no recording is live.`,
    );
  }
  rmSync(PIDFILE, { force: true });

  // Verify the artifact. Do not trust the exit code (rc=255 on SIGINT is normal).
  const info = ffprobeVerify(t, state.output);
  if (res.stoppedBy === "stale" && !info) {
    throw new RunError(`Stale pidfile (pid ${state.pid} is not pomulum) and the output ${state.output} is not readable — ignored.`);
  }
  if (!info || info.durationSeconds <= 0.5 || info.bytes <= 0) {
    const tail = logTail();
    throw new RunError(
      `The recording failed (stopped by ${res.stoppedBy}): ffprobe cannot read ${state.output}. ffmpeg log: ${tail} ${tccHint(1, tail)}`.trimEnd(),
    );
  }
  const kbPerSec = info.bytes / 1024 / info.durationSeconds;
  const elapsedWall = (stopRequestedAt - Date.parse(state.startedAt)) / 1000;
  const wallSeconds = Math.round(elapsedWall * 10) / 10;
  const verdict = captureVerdict(
    info.durationSeconds,
    expectedCapture(state.capSec, elapsedWall, res.stoppedBy === "already-exited"),
  );
  const warnings = stopWarnings(state.mic, info.hasAudio);
  if (verdict.short) {
    // The file is valid and plays up to where it ends, so every fact goes
    // into the error: the agent decides whether to keep it or record again.
    throw new RunError(
      `Short capture: ${state.output} holds ${info.durationSeconds.toFixed(1)} s, expected about ${verdict.expectedSec} s (stopped by ${res.stoppedBy}). avfoundation stopped delivering frames. Record again. ffmpeg log: ${logTail()}`.trimEnd(),
      {
        shortCapture: true,
        stoppedBy: res.stoppedBy,
        output: state.output,
        wallSeconds,
        expectedSec: verdict.expectedSec,
        shortfallSec: verdict.shortfallSec,
        verified: info,
        kbPerSec: Math.round(kbPerSec),
        warnings,
      },
    );
  }
  emitJsonOr(
    a,
    [
      `✅ ${state.output}`,
      `   ${info.width}×${info.height}${info.hasAudio ? " +audio" : ""} · ${info.durationSeconds.toFixed(1)}s · ${(info.bytes / 1048576).toFixed(2)} MB · ${kbPerSec.toFixed(0)} KB/s`,
      `   stopped by ${res.stoppedBy} · wall ${elapsedWall.toFixed(1)}s`,
      ...warnings.map((w) => `   ⚠ ${w}`),
    ].join("\n"),
    {
      stopped: true,
      stoppedBy: res.stoppedBy,
      output: state.output,
      wallSeconds,
      expectedSec: verdict.expectedSec,
      verified: info,
      kbPerSec: Math.round(kbPerSec),
      warnings,
    },
  );
  return 0;
}

// ───────────────────────────── status ────────────────────────────────────

/** `status [--json]` — the agent asks: is a recording in progress, what
 *  does it record, and for how long? The command always exits with 0
 *  (a state is not an error). It reads the pidfile and does not touch
 *  ffmpeg. */
function cmdStatus(argv: string[]): number {
  const a = parseArgv("status", argv, STATUS_FLAGS);
  if (a.bools.has("--help")) {
    process.stdout.write("pomulum status [--json]\n");
    return 0;
  }
  const state = readPidfile();
  if (!state) {
    emitJsonOr(a, "No recording (no pidfile).", {
      recording: false,
      pidfilePresent: false,
    });
    return 0;
  }
  if (state.state === "pending") {
    const ageSec = Math.round((Date.now() - Date.parse(state.startedAt)) / 1000);
    if (ageSec < 60) {
      emitJsonOr(a, `● A record command is starting (${ageSec} s) → ${state.output}`, {
        recording: false,
        starting: true,
        pendingSeconds: ageSec,
        output: state.output,
      });
    } else {
      emitJsonOr(a, `Not recording — a record start went stale (${ageSec} s, no spawn happened).`, {
        recording: false,
        starting: false,
        stale: true,
        pidfilePresent: true,
        output: state.output,
        hint: "the next `record` removes it; `stop` also cleans it up",
      });
    }
    return 0;
  }
  const alive = pidAlive(state.pid) && pidIsOurs(state.pid);
  if (!alive) {
    emitJsonOr(
      a,
      `Not recording — but the pidfile is present (pid ${state.pid} ended). Run \`stop\` to verify and clean up: output ${state.output}`,
      {
        recording: false,
        pidfilePresent: true,
        stale: true,
        pid: state.pid,
        output: state.output,
        hint: "run `node pomulum.ts stop` to verify the file and remove the pidfile",
      },
    );
    return 0;
  }
  const elapsedSec = Math.max(0, (Date.now() - Date.parse(state.startedAt)) / 1000);
  let bytes = 0;
  try {
    bytes = statSync(state.output).size;
  } catch {
    /* ffmpeg did not flush the file yet */
  }
  emitJsonOr(
    a,
    [
      `● Recording — ${Math.floor(elapsedSec / 60)}m${String(Math.floor(elapsedSec % 60)).padStart(2, "0")}s · ${(bytes / 1048576).toFixed(1)} MB`,
      `  → ${state.output}`,
      `  pid ${state.pid} · device [${state.device.index}] ${state.device.name} · crop ${state.crop ? `${state.crop.x}:${state.crop.y}:${state.crop.w}:${state.crop.h}` : "full screen"}`,
    ].join("\n"),
    {
      recording: true,
      pid: state.pid,
      output: state.output,
      startedAt: state.startedAt,
      elapsedSec: Math.round(elapsedSec * 10) / 10,
      capSec: state.capSec,
      bytes,
      crop: state.crop,
      device: state.device,
      command: state.command,
    },
  );
  return 0;
}

// ──────────────────────────────── main ───────────────────────────────────

const HELP = `pomulum ${VERSION} — agent screen recorder (macOS, engine ffmpeg)

USAGE
  pomulum screens [--json] [--no-cache]     list the screens and microphones (avfoundation)
  pomulum snap [--out F] [--screen N]       capture one native-resolution PNG frame
  pomulum record [--crop x:y:w:h] [flags]   start a recording (detached; the prompt returns immediately)
  pomulum status                            is a recording in progress — what, where, how long?
  pomulum stop                              stop the recording and verify it with ffprobe
  pomulum --version                         print the version

RECORD FLAGS
  --crop x:y:w:h    pixel area on the capture frame of the selected screen (origin = top left);
                    a crop that does not fit the screen is refused (exit 2), never shrunk silently
  --screen N        device index from \`screens\` (default: the first screen)
  --duration N      stop automatically after N seconds
  --max-duration N  safety limit when --duration is not set (default 1800 s; 0 = no limit)
  --out FILE        output mp4 (default ~/Desktop/pomulum-<timestamp>.mp4)
  --no-mic          record without audio
  --half            record at half scale (about 55% smaller, VMAF ≈ 91 — softer small text)
  --full-res        full resolution is the default since 0.2.0; kept for old
                    commands — it overrides the half scale of --half/--small
  --small           CRF 28 + half scale — make the file as small as possible
  --dry-run         print the ffmpeg command; do not run it

CONVENTIONS (the contract for agents)
  --json            each command prints JSON to stdout
  exit code         0 = OK · 1 = runtime error · 2 = argument error
  pid/log           /tmp/pomulum-rec.pid · /tmp/pomulum-ffmpeg.log

Requirements: Node >= 22.18 (type stripping) and ffmpeg. The Screen Recording
permission (TCC) belongs to the app that launches the capture — your
terminal or agent host; grant THAT entry in System Settings (an \`ffmpeg\`
entry appears only when ffmpeg runs without an app wrapper).

Agent flow example: screens --json → snap → read the image and select an
area → record --crop → status → stop --json → read the verification result
in the JSON output.`;

function main(argv: string[]): number {
  const cmd = argv[0];
  const rest = argv.slice(1);
  const wantsJson = argv.includes("--json"); // agents get parseable errors too
  try {
    if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
      process.stdout.write(HELP + "\n");
      return 0;
    }
    if (cmd === "-v" || cmd === "--version" || cmd === "version") {
      process.stdout.write(`pomulum ${VERSION}\n`); // one source of truth: the VERSION above
      return 0;
    }
    switch (cmd) {
      case "screens":
        return cmdScreens(rest);
      case "snap":
        return cmdSnap(rest);
      case "record":
        return cmdRecord(rest);
      case "status":
        return cmdStatus(rest);
      case "stop":
        return cmdStop(rest);
      default:
        throw new UsageError(`unknown command \`${cmd}\``);
    }
  } catch (e) {
    const usage = e instanceof UsageError;
    const msg = e instanceof Error ? e.message : String(e);
    if (wantsJson) {
      const details = e instanceof RunError ? e.details : {};
      process.stderr.write(
        JSON.stringify({ error: msg, class: usage ? "usage" : "runtime", ...details }, null, 2) + "\n",
      );
    } else if (usage) {
      process.stderr.write(`Argument error: ${msg}\nType \`node pomulum.ts --help\`.\n`);
    } else {
      process.stderr.write(`Error: ${msg}\n`);
    }
    return usage ? 2 : 1;
  }
}

/** Run only when executed directly (not when a test file imports it). The
 *  realpath comparison keeps the CLI working through a symlink. */
function isDirectRun(): boolean {
  try {
    return (
      pathToFileURL(realpathSync(process.argv[1] ?? "")).href ===
      pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href
    );
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  process.exitCode = main(process.argv.slice(2));
}
