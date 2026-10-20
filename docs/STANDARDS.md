# Quality standards: what "done" means in pomulum

This is the rule list a change is measured against. It is deliberately
short, and every rule names its **enforcement home**: a check in
[`scripts/check.sh`](../scripts/check.sh), a unit test, the e2e script, or a
named review step.

**The meta-rule (M1): encode, do not remind.** A rule that lives only in
this file is a wish. When a rule becomes cheap to check, it moves into
`check.sh` and this file records that. Prose is for judgment calls; the
things that must never be wrong live in code.

Run the automated gates with:

```bash
bash scripts/check.sh          # deterministic gates, no screen access
node --test pomulum.test.ts    # unit tests
bash scripts/e2e-pomulum-ts.sh # real recording end to end (asks for TCC)
```

CI runs the gates above, plus a strict typecheck, on four combinations
(macOS + ubuntu × Node 22 + 24). The e2e script is never in CI: it needs a
real screen and the Screen Recording grant.

Severity for a finding in review: **blocker** (stops a release) ·
**major** (stops unless deferred in writing) · **minor** · **nit**.

## 1. Verification

| ID | Rule | What it means here | Enforced by |
|---|---|---|---|
| V1 | Prove it with the artifact | `stop` verifies the file with ffprobe; we never trust the exit code (rc 255 after SIGINT is normal). A readable file is not proof either: `stop` compares the length with the request and exits 1 on a short capture (`captureVerdict`, unit tested). | unit + e2e + review |
| V2 | Tests run headless, from anywhere | The suite touches no ffmpeg and no screen, and resolves its fixture from the file URL, not the working directory. | `pomulum.test.ts` |
| V3 | The contract holds on failures too | Errors are machine-readable: `{error, class}` on stderr when `--json` is present; exit 0 / 1 / 2. | `check.sh` |
| V4 | One version, one source of truth | `VERSION` in `pomulum.ts`, `package.json`, and what `--version` prints are the same value. | `check.sh` |
| V5 | Explain the number | Every published figure names what limits it; the file also contains the limitation list. Re-measure before you requote. | [BENCHMARK.md](BENCHMARK.md) + review |
| V6 | Fix root causes | The double-start race was fixed at the claim, not by killing the loser. A guard is correct only when the state it handles is legitimate. | review |
| V7 | Test behavior, not implementation | Tests assert what a caller observes: exit codes, JSON fields, golden argv. Not private helpers. | review of tests |
| V8 | Sequence verifiable units | Each commit ends in a state that passed unit + `check.sh` (plus e2e when capture changed). | workflow |

## 2. Boundaries and types

| ID | Rule | What it means here | Enforced by |
|---|---|---|---|
| B1 | Parse at the edges | argv, avfoundation text, ffprobe JSON, and pidfile JSON are untrusted input. The code validates each input where it enters. | review + tests |
| B2 | Pure logic behind the boundary | Crop geometry, duration caps, device selection, and the argument builder are pure functions with a test surface. | `pomulum.test.ts` |
| B3 | Make illegal states unrepresentable | `RecordState` is a union of exactly two shapes (`pending` \| `recording`) with no optional fields; "ended" is derived, never stored. `parsePidfile` validates the shape at read time. | `pomulum.test.ts` + B8 |
| B4 | One place per concept | Crop geometry exists only in the pure helpers; no second copy anywhere. | review |
| B5 | The interface is the test surface | If a behavior needs a test, it needs a seam (a pure function), not a mock of a process. | review |
| B6 | Deletion test before adding a module | One file, no dependencies, no config. A new module must remove complexity from its callers, not move it around. | review |
| B7 | Minimize reader load | No one-caller wrappers, no hidden state. A reader follows `main` → command → pure helper top to bottom. | review |
| B8 | A type is not a guarantee until a compiler sees it | Node strips types without checking them. Until `tsc --strict` runs, a type-level rule (a discriminated union, a branded string) is only documentation. The check runs in CI, with an ephemeral toolchain and no committed dependency, and it also fails on unused locals and parameters. | `.github/workflows/ci.yml` |

## 3. Security

**Threat model.** pomulum is a local CLI that (a) runs with the user's
rights, (b) writes predictably named files in a world-writable directory,
(c) spawns and signals processes, (d) is driven by an agent that reads JSON,
and (e) ships a `SKILL.md` + `install.sh` that other people install. It is
not a server, not a sandbox, and not multi-tenant. Each rule below addresses
one threat in that model.

| ID | Rule | What it means here | Enforced by |
|---|---|---|---|
| S1 | No shell interpolation | Spawns use argv arrays. `shellQuote` is display-only and documented as such. | `check.sh` |
| S2 | Safe runtime files | Files created in a world-writable directory use O_EXCL + mode 0600 and never follow a leftover symlink (CWE-59/CWE-377). Probe and snap output use the private per-user temp directory. | `check.sh` |
| S3 | Identity before signals | Never signal a pid that does not carry both markers (avfoundation + `pomulum-recording`); never a pid ≤ 0; `ps` is called by absolute path. | `check.sh` + unit tests |
| S4 | Fail closed | If the state cannot be written, kill the recording rather than leave an untracked capture. If no signal can be delivered, keep the pidfile instead of pretending the recording ended. | review |
| S5 | Least capability, declared | `SKILL.md` declares what the skill touches: files written, processes spawned, permissions needed, signals sent, deletions. An installer can audit it before install. | `SKILL.md` + review |
| S6 | Skill-content hygiene | No hidden instructions in frontmatter or comments, no network calls, no eval of external content, no telemetry. `install.sh` copies exactly two files and writes a minimal module marker next to them. The package is scanned with an external scanner before a release, and the result is recorded. | external scan + review |
| S7 | Supply chain | Zero runtime dependencies is the control. ffmpeg/ffprobe come from `PATH`; that is a documented trust decision, not an accident. A new dependency is a review decision, not a convenience. | review |
| S8 | No secrets, no network | The tool needs neither. Nothing in the product may start needing them silently. | review |

## 4. Review process

| ID | Rule | What it means here | Enforced by |
|---|---|---|---|
| R1 | Two independent review passes per release | A fresh-eyes source review **and** a behavioral skill eval (a new agent, given only `SKILL.md`, must complete the flow). | workflow |
| R2 | Precision over recall | Verify a finding before you report it. Reproduce it, or quote the exact lines. Fewer real findings beat many plausible ones. | review |
| R3 | Every finding is actionable | file:line + severity + what is wrong + a suggested fix. Reports without locations are rejected. | review |
| R4 | Deferrals are written down | A deferred finding records the decision and the reason, so the next review does not re-litigate it. | commit message |
| R5 | Deterministic constraints wrap the agent | The rules that must never break are checks and tests. The agent's judgment is for design and trade-offs, not for correctness that a script can prove. | `check.sh` |
| R6 | A clean review names what it verified | "No findings" must list the areas inspected, so the absence of findings is evidence, not silence. | review |
| R7 | Structured output when CI lands | The CI pipeline consumes JSON (SARIF-style) rather than parsing prose. | backlog |

## 5. Documentation and distribution

| ID | Rule | What it means here | Enforced by |
|---|---|---|---|
| D1 | CLI and help cannot drift | Every command appears in `--help`; a command without help text fails the gate. | `check.sh` |
| D2 | Claims trace to a measurement | No number in the README or docs without the measurement that produced it. | review |
| D3 | Version claims are exact | The real minimum (`>= 22.18`), not an approximation. An overstated requirement sends users to a broken command. | `check.sh` + review |
| D4 | Product content in English, STE | Simple, consistent English (ASD-STE100 subset). Vietnamese appears only as skill trigger phrases. The exception register in section 9 lists the approved non-STE terms. | review + the 2026-10-19 audit |
| D5 | Layered documents | README (user) → `docs/` (design, evidence, standards) → `SKILL.md` (agent). Each layer stands alone. | review |
| D6 | The research stays private | The public tree is the `pomulum/` subtree only, and no shipped file may reference the private workspace or a home path. | `check.sh` |
| D7 | One remedy, one wording | A user-facing remedy comes from one shared constant, and every shipped file is scanned for the wrong version of it. The Screen Recording grant belongs to the app that runs the capture, not to a helper. One wrong message sent users to a nonexistent entry. | `check.sh` + unit test |
| D8 | No dangling references | Every relative link and `src` in the shipped docs resolves to a file in the tree. Deleting a file must delete its references too; a shipped README once pointed at a removed script. | `check.sh` |

## 6. Compliance snapshot

Audited 2026-10-16 against the running code (v0.1.0).

> **2026-10-18 re-audit (v0.1.1).** An external claim benchmark (a 60 s live
> recording of a second display plus a re-run of the encoder matrix) found
> swapped libvmaf inputs behind every published VMAF figure; the prose review
> missed this D2/V5 failure. It also found a partial dimension cache that let
> `screens --json` report `width: null` with exit 0 (caught by the manual
> e2e, which is not in CI). Both fixed: the bench scripts pass the encoded
> file first, and we re-measured the quality figures; the cache invariant is
> now a pure, tested function (`screensNeedingProbe`), and `--dry-run`
> writes nothing.
>
> The same audit moved the default to full resolution (v0.2.0): the
> half-scale default had been a product decision made on the inflated
> numbers. R1 for 0.2.0: an independent fresh-eyes review of the whole diff
> since the public 0.1.0 (one major, four minor, one nit; all fixed in this
> pass) plus the live behavioral runs of the same day.
>
> **2026-10-19 (docs).** An ASD-STE100 audit of the six shipped docs
> measured 47.8% clean sentences; the STE pass applied its findings, and
> section 9 records the approved exceptions.

| Area | Status | Note |
|---|---|---|
| V1, V2, V3, V4 | ok | Enforced by e2e, the unit suite, and `check.sh` (12 gates). |
| V5 | ok | Every README figure traces to `docs/BENCHMARK.md`, which carries its own limitation list. |
| V6, V7 | ok | Applied during the race-hardening pass; deferred items are recorded in the commit. The 0.1.0 pass fixed two root causes at the boundary: a crop that does not fit is refused instead of clamped, and the half-scale filter cannot ask for an odd width. |
| B1, B2, B4, B5 | ok | Pure helpers own the geometry; the edges parse the inputs. |
| B3, B8 | ok | `RecordState` is a two-shape union with `parsePidfile` as the tested seam; strict typecheck runs in CI. |
| S1, S2, S3, S4 | ok | Hardened in this pass: safe runtime-file creation, absolute `ps`, fail-closed pidfile write. |
| S5 | ok | `SKILL.md` declares its capability surface: what it runs, writes, reads, and signals. |
| S6, S7, S8 | ok | No network, no telemetry, no eval, two copied files, zero dependencies. SkillSpector 2.12.0 static scan: risk score 0/100, zero findings, coverage 100%. Its own `CAUTION` label reflects a partial reference ledger (the skill references `pomulum.ts`, which appears only after `install.sh`), not a finding. |
| R1–R6 | ok | The last release used both review passes and produced severity-tagged findings. |
| R7 | partial | CI gates every change on four runner combinations. Machine-readable reporting (JSON/SARIF) waits until something consumes it; the gates print text for a human. |
| D1, D6, D8 | ok | Gate-enforced; D8 was added after deleting the logo generator left a reference behind. |
| D2–D5 | ok | Review-enforced. |
| D7 | ok | `TCC_REMEDY` is the single remedy string, `check.sh` scans every shipped file for the wrong phrasing, and the zero-device message is pinned to the constant by a unit test. |
| B8 | ok | Strict typecheck added to CI. The first full run found the tree clean, and proved the point: nothing had ever checked it. |

## 7. Deliberate decisions (do not re-litigate)

Recorded so a future review does not re-open them. Each one had a real
finding behind it and a reason to keep the behavior.

1. **`--duration` has no upper bound.** An explicit duration is explicit
   intent; the 30-minute cap exists for the case where the agent sets no
   duration at all. Clamping an explicit value would make the flag lie.
2. **SIGKILL requires evidence.** Before the final signal, `stop` waits
   while the output file keeps growing (bounded to 5 s): a growing file is
   ffmpeg finalizing the `+faststart` trailer, not a stuck process.
3. **The pidfile and log stay at fixed `/tmp` paths.** Agents depend on the
   documented paths, so the contract wins. The hardening is O_EXCL, mode
   0600, and a symlink check; the paths do not move.
4. **Probe and snap output use the private per-user temp directory.** Those
   paths are not part of the contract, so there is nothing to keep.
5. **The e2e script is never in CI.** It needs a real screen and the Screen
   Recording grant; a hosted runner has neither.
6. **No committed dependency, not even for the typecheck.** CI installs
   TypeScript into the runner's temp directory. The product keeps zero
   dependencies.
7. **Non-darwin platforms spawn ffmpeg directly, without `caffeinate`.**
   macOS is the target; the branch exists so the process model stays
   honest, not to promise Linux recording. The tool has no separate
   macOS-only guard. The first command fails with avfoundation's own
   reason, which names the cause better than a generic refusal.
8. **`record` refuses a crop the clamp shrank below the usable minimum**
   (16 px of input at half scale; 8 px at full resolution, the default) with exit 2, naming the real
   screen size and the largest area at that origin. Clamping a 100×200
   request to 2×2 and then letting libx264 reject the 1-pixel frame turned a
   coordinate error into an encoder error one second later. A crop that fits
   *partly* still clamps; the JSON carries `requestedCrop` next to the
   applied `crop` with `cropClamped: true`, so it is never silent.
9. **`package.json` stays `private: true`; pomulum is not published to
   npm.** Distribution is a clone plus `install.sh`, because the product is
   one file plus a skill, not a library. The manifest exists so `engines`,
   the version, the keywords, and the `npm test|check|e2e` shorthands are
   declared in the place tooling already looks.

## 8. Adoption order

1. **Done:** CI runs `check.sh` on four runner combinations, and a strict
   typecheck (B8).
2. **Done:** B3 — `RecordState` is a discriminated union, `parsePidfile` is
   the tested seam, and the shape is validated at read time.
3. **Done:** S5 — `SKILL.md` carries the capability declaration.
4. **Done:** the skill package was scanned with SkillSpector 2.12.0
   (project-local environment, `--no-llm`): risk score 0/100, zero findings.
   The scan also surfaced a packaging defect — the installed folder needed a
   module marker, or Node printed a warning on stderr for every command.
   Re-scan whenever the skill changes.
5. **When a consumer exists:** R7 — emit the gate results as JSON/SARIF.
6. **Done (0.1.0):** D7 — the TCC remedy is one constant, and the wrong
   phrasing fails the gate. The rule came from a shipped message that told
   users to grant Screen Recording to a helper tool.
7. **Always:** keep R1 per release. Move every new rule into `check.sh` or
   CI as soon as we can check it.

## Sources

Curated from the following, filtered for a one-file, no-dependency,
macOS-only CLI that ships an agent skill:

- The session skill **improve-codebase-architecture**: the vocabulary of
  module, interface, depth, seam, and adapter; the deletion test; "the
  interface is the test surface". These inform B5–B7.
- **[alibaba/open-code-review](https://github.com/alibaba/open-code-review)**:
  deterministic engineering around an agent for the steps that must not go
  wrong; precision over recall; line-level, severity-tagged findings;
  structured output for CI. These inform R2, R3, R5, R7.
- **[NVIDIA/SkillSpector](https://github.com/nvidia/skillspector)**: the
  agent-skill threat taxonomy (prompt injection, data exfiltration,
  privilege escalation, supply chain, excessive agency, tool poisoning, and
  least privilege), fail-closed gates, and the discipline of documenting a
  trust model. These inform S5–S8.
- **[cursor/plugins — pstack](https://github.com/cursor/plugins/tree/main/pstack)**:
  the principle set (laziness-protocol, boundary-discipline,
  type-system-discipline, make-operations-idempotent, prove-it-works,
  fix-root-causes, test-behavior-not-implementation, explain-the-number,
  sequence-verifiable-units, encode-lessons-in-structure). These inform
  M1 and most of V and B.

## 9. D4 exception register and glossary (STE)

The STE audit of 2026-10-19 set the compliance target (≥ 80% clean
sentences) and approved the terms below as permanent exceptions. They are
product nouns, macOS terms, or the document's own mnemonics; a future audit
scores against this register instead of re-arguing each term.

**Approved non-STE terms (do not rewrite):**

- **recording** (noun) and **the Screen Recording permission/grant/remedy**
  (macOS's own Settings label and our constant's subject)
- **type stripping** (Node.js's official name for erasable-types execution)
- **gate / gates / check**: this file's name for automated enforcement
- **seam, the edges, deletion test**: sourced vocabulary (see Sources; B5–B7)
- **M1 mnemonics**: "encode, do not remind"; "a rule that lives only in this
  file is a wish"; "make the flag lie"; "the contract wins"; "evidence, not
  silence"; "one pidfile, one truth"
- the README **name story** ("What is in the name") and its wordplay
- **"sweet spot"**: retired from prose and titles in the 2026-10-19 pass; if
  it returns, only as the bold verdict label in a result table

**Still required by D4 (no exception):**

- no em-dash clause joiners; sentences ≤ 25 words (≤ 20 in instructions);
  active voice where the actor matters; no slang beyond the register above;
  one instruction per sentence; spell out one to nine when counting objects
- the *preferred* split for flag combinations: say what a mode does, not
  what disables what
