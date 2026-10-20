# Contributing

pomulum is one file. Keep it that way: no runtime dependencies, no build
step. Node >= 22.18 runs `pomulum.ts` as it is.

## Before you open a pull request

```bash
bash scripts/check.sh             # deterministic gates, no screen access
node --test pomulum.test.ts       # unit tests: pure functions only
bash scripts/e2e-pomulum-ts.sh    # a real recording, on a Mac with the Screen Recording grant
```

CI runs the first two plus a strict typecheck on macOS and ubuntu, Node 22
and 24. It cannot run the e2e: a hosted runner has no screen and no grant.
Run it yourself and paste the `RESULT` line of `/tmp/pomulum-e2e.log` into
the pull request.

## Rules

- Every rule the code is held to is in [docs/STANDARDS.md](docs/STANDARDS.md),
  with the gate, test or review step that enforces it.
- New behaviour gets a pure, exported function and a unit test. Logic that
  lives only inside a command handler is a known review finding.
- A behaviour change bumps the version in the three places that must agree
  (`VERSION` in `pomulum.ts`, `package.json`, what `--version` prints;
  `check.sh` fails otherwise) and adds a CHANGELOG entry, newest first.
- Every number in the docs traces to a stored measurement
  ([docs/BENCHMARK.md](docs/BENCHMARK.md)). Re-measure; never re-quote.
- Product text is English in the ASD-STE100 style: short sentences, active
  voice, one meaning per word, no em-dashes.
- Commit subjects are short and imperative. The body says why.

## AI policy

Use of AI in contributions is neither encouraged nor prohibited; changes are
judged on their merits. Test and review a pull request yourself before you
open it. Low-effort generated submissions are closed.
