# Engineering rules — DFAI

These are the engineering rules for this repository. Together with `CLAUDE.md`
they are the authority here, and they **take precedence over any user-level
rules or agents** (`~/.claude/CLAUDE.md`, `~/.claude/agents/`) on whatever
machine the work happens on. A machine may carry a different standard — a work
laptop, say — and that standard does not apply to DFAI. Where the two
disagree, this file and `CLAUDE.md` win.

`CLAUDE.md` adds the DFAI specifics (stack, commands, the traps this codebase
has) and may tighten these rules, but never contradicts them. If the project
genuinely needs an exception, it says so explicitly and says why.

**The maintainer is James Hoffman.** Use that name for authorship, owners and
bylines. Never guess a first name from "jhoffman" — if a name is needed and not
given, write `[Your name]` instead.

## Architecture — the rule that matters

**Dependencies point inward.** Domain → nothing. Application → domain.
Infrastructure/adapters → application + domain. Presentation → application (and
domain _types_ only). Never the reverse, and never a cycle.

In DFAI the four roles are the `packages/*` layers (see "Shape of the code" in
`CLAUDE.md`), and ESLint enforces the direction:

- **Domain** — the rules the product actually is: entities, invariants,
  algorithms, policy. **No framework, no I/O, no clock, no randomness.** Inject a
  `Clock` and an `Rng`; `Date.now()` and `Math.random()` in domain code is a bug,
  because it makes the rules untestable and non-reproducible.
- **Application** — use-cases that orchestrate the domain, plus the _ports_ they
  need (`SaveStore`, `Clock`, `Rng`, ...). Returns plain data or events.
- **Adapters / infrastructure** — the implementations of those ports: HTTP, DB,
  filesystem, localStorage, audio, canvas, SDKs. **Thin.** They translate; they
  do not decide.
- **Presentation** — UI. **Holds zero business rules.** If a component is
  deciding what happens next rather than how it looks, it is in the wrong layer.

Cross-module imports go through a module's public entry point, not into its
internals.

## Clean Code — enforced in review

- Names say _what_, not _how_. No `data` / `info` / `manager` / `helper` as a
  whole name. Never shadow a global or built-in identifier.
- One thing per function; prefer < ~30 lines; **> 3 params → pass an object**.
- Comments explain _why_, or a non-obvious constraint — never restate the code.
- No dead code, no commented-out code. No `any` without a one-line reason.
- Errors are handled or propagated on purpose — never silently swallowed. A
  deliberately ignored error gets a comment saying why it is safe to ignore.
- One reason to change per module. Rules + rendering + I/O in one file → split.
- Match the surrounding code's idiom, naming and comment density.

## Testing — required to merge

**Coverage floor: 70% of lines, repo-wide, enforced in CI.** Coverage is not
spread evenly. Roughly 20% of the code carries 80% of the impact — domain
rules, core use-cases, and anything touching saves, auth, money, or personal
data. That slice is named in `COVERAGE.md` and held at **90%+ lines with every
rule tested**. Write those tests first; glue code may sit below the floor as
long as the repo-wide 70% holds.

All three kinds of test are required, not just unit:

| Layer        | Kind                                                                  | Bar                                                                            |
| ------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| domain       | unit, pure, seeded RNG + fixed clock                                  | 90%+ lines; every rule and invariant tested                                    |
| application  | unit, fake adapters                                                   | every use-case, happy path + key edges                                         |
| adapters     | **integration** against the real thing (or a faithful local emulator) | round-trip **and** failure modes: timeouts, malformed data, denied permissions |
| presentation | component + **end-to-end** smoke                                      | key flows render; the core loop is e2e-green on every merge                    |

- Test behaviour, not implementation. **No snapshot test as a stand-in for a
  behaviour test.** Coverage from tests with no meaningful assertion does not
  count toward the floor.
- A bug fix ships with the test that would have caught it, committed _before_
  the fix so the test is seen to fail first.
- Tests must be deterministic: seed the RNG, fix the clock, no sleeps on real
  time, no order dependence. A flaky test is a bug, not a retry.
- When a test fails, report it with the output. Never describe unrun tests as
  passing.

## Before hand-off

Run the full gate — `pnpm gate` (format, typecheck, lint, tests + coverage,
build, Rust lint + tests) — and say what was run and what it said. For anything
touching behaviour, `pnpm e2e` is part of the gate.

Never claim something works because it compiles. Verify the actual behaviour.

## Agents

The specialised subagents for this repo live in `.claude/agents/` and follow
these rules without restating them: `coder`, `code-reviewer`, `tester`,
`adversarial-tester`, `bug-fixer`, `pr-review-fixer`.
A project agent overrides a user-level agent of the same name, so these are the
ones that run here whatever `~/.claude/agents/` holds.

Prefer delegating to the narrow agent over doing the job ad hoc; each one knows
its own hand-off contract (what it may change, what it must report). `coder`,
`bug-fixer` and `pr-review-fixer` may change code; `code-reviewer`, `tester` and
`adversarial-tester` never do.

## Machine notes (James's Macs)

Node is Homebrew-installed: bash calls need `export PATH="/opt/homebrew/bin:$PATH"`.
Rust lives in `~/.cargo`; the npm scripts put it on PATH themselves.
