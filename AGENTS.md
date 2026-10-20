# pomulum

Agent screen recorder for macOS: one file (`pomulum.ts`), no dependencies,
ffmpeg does the capture. Read [README.md](README.md) first, then
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Conventions

- No runtime dependencies, no build step. Node >= 22.18 runs the file as it
  is (type stripping), so write erasable TypeScript only: no enums, no
  parameter properties, no namespaces.
- Every command answers `--json`; exit 0 = OK, 1 = runtime error, 2 =
  argument error. A new fact goes into the JSON before the human text.
- Trust ffprobe, never ffmpeg's exit code. Do not trust a readable file
  either: `stop` compares the file length with what was requested.
- Runtime discovery: device indexes change between sessions. Never store an
  index as a constant in code or docs.
- New logic gets a pure, exported function and a unit test in
  `pomulum.test.ts`. Tests never touch ffmpeg or the screen.
- Comment only what the code cannot say: a constraint, a measured pitfall,
  an intentional difference. Keep it short.
- Product text is English in the ASD-STE100 style. No em-dashes.
- The version lives in three places that must agree: `VERSION` in
  `pomulum.ts`, `package.json`, and what `--version` prints.
- Commit subjects are short and imperative; the body says why.

## Layout

- `pomulum.ts`: the whole program. `pomulum.test.ts`: unit tests.
- `scripts/check.sh`: deterministic gates, no screen access.
  `scripts/e2e-pomulum-ts.sh`: a real recording, run by hand on a Mac.
- `skills/pomulum/`: the skill other agents install (`SKILL.md` plus a copy
  of `pomulum.ts`, refreshed by `install.sh`).
- `docs/`: STANDARDS (rules and what enforces them), ARCHITECTURE,
  BENCHMARK, `flow.svg`. `tests/fixtures/`: real avfoundation output.

## Validation

- Code: `bash scripts/check.sh`, `node --test pomulum.test.ts`, and the
  strict typecheck with the exact flags in `.github/workflows/ci.yml`.
- Behaviour: `bash scripts/e2e-pomulum-ts.sh` on a real Mac; read the
  `RESULT` line of `/tmp/pomulum-e2e.log`.
- After `pomulum.ts` changes: `bash skills/pomulum/install.sh --all`.
- Docs: every relative link must resolve (`check.sh` gates it). No path
  from outside the repository in any shipped file.
