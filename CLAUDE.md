# DFAI — working notes

Local-first desktop app replacing Notion and Obsidian.

**The app is DFAI (Daily Flow AI).** It was called Atlas until 2026-10-20
(#482, ADR-0042); the repo was renamed from `jhoffman-dev/atlas` to `jhoffman-dev/dfai`, and GitHub redirects the old URLs.
Write "DFAI" in everything a person reads. Some internal names keep "atlas" on
purpose, because files, other Macs or other tools depend on them: the vault
folder `.atlas/`, `atlas-query` fences, `atlas_*` frontmatter keys and MCP tool
names, `ATLAS_*` environment variables, `atlas.*` localStorage keys, the
`/v1/atlas-query` route, the `Atlas sync` lines in `.gitignore` and commit
subjects, and code identifiers such as `AtlasQuery`. ADR-0042 says why each one
stays; don't rename them without a decision that replaces it.

**`ENGINEERING.md` and this file are the authority for this repo.** `ENGINEERING.md`
holds the engineering rules — Clean Architecture, Clean Code, the testing bar, the
hand-off gate, and the agents — and this file adds repo-specific detail: stack,
commands, and the traps this codebase has. Together they **take precedence over
any user-level rules or agents** (`~/.claude/CLAUDE.md`, `~/.claude/agents/`),
which may hold a different standard on the machine you are running on (a work
laptop, for instance). If a user-level rule contradicts these files, these files
win. If this file ever appears to contradict `ENGINEERING.md`, `ENGINEERING.md`
wins and this file is the thing that is wrong.

## Use the agents

The specialised subagents in `.claude/agents/` (committed with the repo) are not
optional and not a fallback. Claude Code lets a project agent override a
user-level agent of the same name, so these are the ones that run here, whatever
`~/.claude/agents/` holds on this machine. **Delegate to the narrow agent rather
than doing the job ad hoc**, and spawn them wherever they fit — including several
in parallel when the work divides cleanly.

| Want to…                                 | Use                     |
| ---------------------------------------- | ----------------------- |
| Build a feature, refactor, phase of work | `coder`                 |
| Fix a reported bug or a failing test     | `bug-fixer`             |
| Review a diff, branch or PR              | `code-reviewer`         |
| Run the gate and report it faithfully    | `tester`                |
| Try to break what was just built         | `adversarial-tester`    |
| Raise coverage on an untested module     | `test-writer`           |
| Make a branch clean before review        | `linter`                |
| Apply review comments on a PR            | `pr-review-fixer`       |
| Write up a decision or a status page     | `documenter` (Notion) ¹ |

¹ `documenter` is not in this repo: it needs a Notion connector, and only James's
own `~/.claude/agents/` has it. Where it is absent, write ADRs in
`vault/docs/adr/` instead.

`coder`, `bug-fixer` and `pr-review-fixer` may change code. `code-reviewer`,
`tester` and `adversarial-tester` never do.

Each phase of `PLAN.md` is a `coder` task, and **every phase gets a
`code-reviewer` pass and an `adversarial-tester` pass before it is called done**.
Doing a whole phase inline, then reporting it green, is the failure mode this
section exists to prevent.

### Keep the guide, the API and the MCP in step

The app, its how-to guide, and its local API + MCP server describe one product.
They drift the moment a change lands in only one of them. So **every change that
reaches the user** — a feature, a behaviour fix, a renamed control, a new
property kind — gets two follow-up agents, spawned in parallel as soon as the
change is merged. Don't wait to be asked:

| Keeper         | Agent   | Owns                                                                                                       | Done when                                                                                                                                                                        |
| -------------- | ------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Guide keeper   | `coder` | The DFAI Field Guide (`docs/guide/index.html`)                                                             | The guide describes what the app now does, in James's words, with nothing stale left in it. The coordinator then republishes it as a claude.ai artifact (see below).             |
| API/MCP keeper | `coder` | `packages/application/src/api` (routes + contract), `apps/mcp/src/tools`, `vault/docs/api/v1.md`, ADR-0016 | Anything the user can now do in the app can also be done or read through the API and an MCP tool, or the card says why not. Tests are added, and the API doc matches the routes. |

- The API/MCP keeper's work is code: it gets its own `code-reviewer` and
  `adversarial-tester` pass like any other change. The API is reachable by any
  local process, so every new route follows the rules in ADR-0016 and ADR-0017:
  it names its vault, never hands out a secret, and uses byte-preserving writes.
- A change that is internal only (a refactor, a test, a fix nobody can see)
  needs neither keeper. Say so in the hand-off rather than skipping it silently.
- A hand-off names both keepers' results: guide updated or not needed, and API/MCP
  updated or not needed.
- The guide's source is `docs/guide/src/`, in the repo, so it is public:
  examples use fictional names only. Each section is a file in
  `docs/guide/src/sections/`, listed in order in `docs/guide/src/page.html`;
  `pnpm guide:build` assembles them (and the contents list) into
  `docs/guide/index.html`, the self-contained page that is published, and a test
  fails while it is stale. Never edit `index.html` by hand. Publish it as a
  claude.ai artifact from the account the session runs under; the first publish
  from a new account creates a new URL — tell James the URL and record it here. The current published copy is
  `claude.ai/artifact/XS3G54GvnJqpG5RFw6DjF8`, published 2026-10-11 from the
  work-account session. (The earlier personal-account copy is
  `claude.ai/artifact/QXvTge2zPuY5YS5g7QYveH`, last updated 2026-10-07.)

## Working with James

The maintainer is James Hoffman. These come from his feedback and hold on every
machine:

- **This repository is public.** Never put real names of his employer, its
  clients, vendors, coworkers or family into anything that is committed or
  posted — code, tests, fixtures, docs, ADRs, commit messages, issues or PR
  text. Use clearly fictional names (Larkspur Payroll, Mara Quill, Tobias Fenn)
  and `example.com` addresses. Real meetings and notes belong in his vault
  (a separate private repo), never here. This matters most on his work laptop,
  where work context is close at hand. A pre-publication scrub was needed once;
  the full private history lives in `jhoffman-dev/atlas-archive`.
- **Two machines, one repo.** He works from a personal Mac and a work laptop.
  Before starting, `git pull`; claim an issue by assigning it to yourself
  (`gh issue edit <n> --add-assignee @me`) and skip issues already assigned or
  with an open PR. Changes reach `main` through a pull request (a ruleset
  requires it; the admin bypass is for the coordinator's merges, not a habit).
- **A pull request that is not ready to merge is a draft.** Open every PR with
  `gh pr create --draft`. Mark it ready (`gh pr ready <n>`) only when it has
  passed its `code-reviewer` and `adversarial-tester` passes, the fixes are in,
  the gate and e2e are verified, and everything it is stacked on has merged or
  is ready too. If a ready PR turns out not to be, put it back
  (`gh pr ready <n> --undo`). James merges every PR himself and reads "open, not
  draft" as "safe to merge" — the draft flag is the signal he acts on, not a
  message in a chat.

- **Never guess his first name** from "jhoffman". It is James; if a name is
  needed and unknown, write `[Your name]`. (Claude has invented "Jordan" before.)
- **Delegate to the agents by default, and in parallel** where the work divides —
  see "Use the agents". Doing a job ad hoc is a correction he has made.
- **Stage exact paths.** Never `git add <folder>` where the app edits the tree —
  `vault/` is changed by the running app, its automations and sync. Check
  `git status --porcelain <folder>` and add only the files you changed; treat an
  unexpected deletion or move as the app's doing. A folder add once committed an
  archive automation's moves of 128 cards as deletions.
- **Every hand-off says whether the app needs a restart, and the command.** He
  runs `pnpm tauri:dev` from the main checkout: frontend changes show live, Rust
  changes rebuild and relaunch, dependency changes need a stop,
  `pnpm install`, and a rerun.
- **Merge flow.** Each agent works in its own worktree on its own branch. Merge
  with `git merge --no-ff`, then check `git diff --stat <branch> main` is empty
  so nothing was dropped (if `main` had moved, it shows only `main`'s own
  changes). If `main` moved while the branch was out, run the gate
  on the combined `main` before calling it done.

## Before starting any work, read the issues

Tasks live in **GitHub Issues** on `jhoffman-dev/dfai`, so every machine
and every Claude Code account works from the same list:

```sh
gh issue list -R jhoffman-dev/dfai                   # open work
gh issue list -R jhoffman-dev/dfai --label next      # do these first
gh issue view <n> -R jhoffman-dev/dfai               # the whole card
```

- **`from-james`** — James asked for it; it takes priority over the phase plan.
- **`next`** — do this next. **`backlog`** — pick it up when it fits, and say why
  you did or did not.
- **`follow-up`** — left over from a review or fix. **`feature`** — new capability.

Keep the issues current as you work: comment what you did, close an issue only when
its work is merged and pushed, and file new work (review findings, follow-ups) as
new issues rather than notes in a reply. An issue left open after its work landed
is a lie about the state of the project.

`vault/tasks/` holds the **history** of the board up to 2026-09-29 (done and archived
cards, read-only); don't add cards there. Its ids (`P<phase>-<nn>`, `U-<nn>`, `A…`)
are what older commits and ADRs refer to.

## Running tickets in parallel

Clean layers do not stop two features from editing the same use-case, or every
feature from appending to the same few files. On 2026-10-12 three features built
side by side each had to be re-merged and re-verified after every other merge
(#134). So:

- **Every ticket lists what it touches** — `Touches` (the shared use-cases,
  ports and append-point files it edits), `Must land after` and
  `Must not run beside`. The issue template
  (`.github/ISSUE_TEMPLATE/ticket.md`) has the sections and the list of known
  append points; `gh issue create --template ticket.md` starts from it. A
  ticket without the lists gets them before it is picked up.
- **The coordinator runs tickets in parallel only when their lists do not
  overlap.** Tickets in one epic that share a use-case are stacked or done in
  order, never side by side.
- **A shared seam change is its own small PR, merged first.** When two tickets
  need the same change to a shared use-case or port, that change lands alone
  before either feature starts.
- **Never hard-code a cross-feature count in a test** — a tool count, a route
  count, a number of surfaces. Every feature that adds one breaks every other
  open PR. Derive the expected list from its source instead.

## Commands

```sh
pnpm tauri:dev       # run the app
pnpm gate            # format, typecheck, lint, tests + coverage, build, rust lint + tests
pnpm e2e             # Playwright in WebKit
pnpm perf:budgets    # the work budgets: what each action makes the app do, against tools/perf/budgets.json
pnpm design:refs     # render design/target mockups to design/out/refs (design/README.md)
pnpm shots           # screenshot the built app's surfaces to design/out/shots
pnpm design:compare  # mockup beside app, per surface, at design/out/compare/index.html
```

**The e2e suite runs against `dist`, not against your source.** `pnpm e2e` now
builds first for exactly this reason. If you ever run `playwright test` directly,
build first or you are testing the previous bundle — which can fail code that
works, and pass code that does not.

**CI splits the slow work across machines** (`.github/workflows/gate.yml`): the
unit tests over six Linux shards, dealt by recorded duration, whose coverage the `coverage` job merges and
holds to the thresholds, the e2e suite over eight Linux shards in Playwright
WebKit (the page is told it runs on a Mac; `@mac` tests are skipped), Rust on
one Mac. The whole e2e suite, `@mac` tests included, runs nightly on macOS
(`e2e-macos-nightly.yml`). `gate` is still the one required check. A pull request that touches only
documentation, as `tools/ci/docs-only.ts` defines it, runs `static` alone. A
failed e2e shard uploads its HTML report as `playwright-report-<n>` (no traces:
tracing every test cost a third more time). To run one shard here:
`pnpm e2e --shard=2/8`.

**Check CI by commit, never by "the latest run".** A run is not registered the
instant a push returns, so `gh run list --limit 1` will happily hand back the
_previous_ run and its conclusion. This has already caused a phase to be reported
as green when it was red.

```sh
gh run list --commit "$(git rev-parse HEAD)" --limit 1 --json status,conclusion
```

**Read a red run's annotation before explaining it.** A job that fails in ten
seconds without running a step is not a code failure — in September 2026 it was
GitHub billing, and a commit message confidently blamed a Node version first.

```sh
gh api "repos/{owner}/{repo}/check-runs/<job-id>/annotations" -q '.[].message'
```

**The work budgets fail the gate when the app does more work** (`tools/perf/budgets.json`,
the `perf` job). Each action on the 2,008-note fixture — open a note, type, autosave,
tick, file from the Inbox, ⌘K, drag a card, and 3 s idle — is held to a count of React
commits, component renders and host calls by command name, and a few hard per-row
rules (ticking one task renders one `TaskRow`). Counts, not times: the run is on a
work clock (`tools/perf/work-clock.ts`) with virtual time and the host's answers handed
over one at a time, so the same build gives the same counts on every machine. Times are
printed and put in the job summary, never failed on. A failure names the action, the
count, budget against actual, and the components and commands that did most.
`pnpm perf:budgets` runs it here; `PERF_BUDGETS=write pnpm perf:budgets` writes a run's
counts into the file and only ever lowers a budget. A count under half its budget fails
too (the action probably did not happen), and `write` will not lower past that floor
without `PERF_BUDGETS_ALLOW_DROP=1`, nor drop an action it no longer measures without
`PERF_BUDGETS_ALLOW_RENAME=1`. `PERF_BUDGETS_RUNS=N` counts N times and fails on any
difference (CI counts twice, each run on its own Linux machine, in four parts in all; the `perf`
job holds run 2 to run 1 and checks every action was counted on both runs and timed, once each). `pnpm perf` here builds minified; CI's `perf` job times
the unminified build it counts with, so local times differ a little from CI's.

Each checkout serves its e2e build on its own port, derived from its path (see
`playwright.config.ts`), so suites in two worktrees can run at the same time.
`E2E_PORT` overrides it.

Rust lives in `~/.cargo`; the npm scripts put it on PATH themselves.

## Shape of the code

Dependencies point inward, and ESLint enforces it — each layer has a
`no-restricted-imports` zone in `eslint.config.js`.

**The webview has no Node.** Vitest runs on Node, so `Buffer`, `process` or an
import of `node:fs` passes every unit test and fails only in WebKit. ESLint
forbids Node's globals and modules in the packages, `apps/desktop/src` and
`apps/web/src` (tests are exempt, and test support that runs on Node is named in
`eslint.config.js`, where nothing the app builds may import it), and
`pnpm check:node-builtins` fails the gate when a built-in or a polyfill of one
reaches either built bundle, the desktop's or the web's, anyway (#53, #114), and
when anything of Tauri reaches the web's (#656).

| Where                  | What belongs there                                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `packages/domain`      | The rules. Pure, no I/O, no clock, no randomness.                                                                |
| `packages/application` | Use-cases and the ports they need.                                                                               |
| `packages/adapters`    | Markdown, the index, the readers. Thin translators. Tauri IPC is its own entry, `@dfai/adapters/tauri` (#656).   |
| `packages/ui`          | React components. No business rules.                                                                             |
| `packages/shell`       | The app shell every platform shares: the window, its hooks, stores and styles. No Tauri (ESLint holds it, #656). |
| `apps/desktop`         | The desktop's composition root (the shell on the Tauri adapters), plus `src-tauri` (Rust).                       |
| `apps/web`             | The web's composition root: a stub, the shell on an in-memory sample vault, until the web adapters land (#656).  |

**A feature adds a file rather than editing a shared one** (#134). Styles: a new
`packages/shell/src/styles/<feature>.css`, imported from `styles/index.css` at the
place its rules belong in the cascade (the build still emits one stylesheet).
Guide: a new `docs/guide/src/sections/<id>.html` and its line in `page.html`,
then `pnpm guide:build`. Shots: a new `tools/design/shots/<surface>.shots.spec.ts`
on the helpers in `kit.ts`.

**Where new things go, so parallel work adds files rather than editing shared
ones (#134).** A route goes in its area's `packages/application/src/api/contract/<area>.ts`
(route, request and answer shapes) and `api/handlers/<area>.ts` (what answers it);
a new area adds one line each to `contract.ts` and `routes.ts`, which only compose.
A module's exports go in its own `index.ts`. The index's tables and indexes live
only in `apps/desktop/src-tauri/src/index_schema.sql`: the host `include_str!`s it,
test indexes read it (`testing/index-schema.ts`), and `index-schema.test.ts` fails
if an inline copy in a test drifts from it.

**The web build is hosted on Firebase (#662)**, in the project `dailyflowai-app`,
on its own site `dailyflowai-web` (dailyflowai-web.web.app) through the hosting
target `web` (`.firebaserc`). The project's default site, `dailyflowai-app`,
serves something else: never deploy to it, and never touch the projects
`gcal-timeblocking` or `student-games-be188`. `firebase.json` holds the site's
SPA rewrite, cache headers (`/assets/**` immutable, everything else `no-cache`;
the assets rule comes last so it wins) and security headers, whose CSP is
`apps/web/index.html`'s plus `frame-ancestors 'none'`: change the two together.
`.github/workflows/web-hosting.yml` builds and deploys it, apart from `gate` and
only when a path the web build reads changed: live on a push to `main`, a 7-day
preview channel on a pull request; it skips green until the secret
`FIREBASE_SERVICE_ACCOUNT_DAILYFLOWAI_APP` exists. Deploy by hand only with
`firebase deploy --only hosting:web`, never a bare `firebase deploy`;
`tools/ci/web-hosting.test.ts` fails on a config or workflow that could reach
another site. A later functions codebase (#663) widens that test on purpose.

**Rust reads files, watches them, and runs SQL. It decides nothing** — see
`vault/docs/adr/0005-the-index-decides-nothing.md`, and
`0014-the-host-walks-the-vault-and-is-told-what-to-skip.md` for the one nuance:
Rust prunes directories it is _handed_ by the domain, which is obeying a rule
rather than having one. A rule that exists in both Rust
and TypeScript will drift, and the version the user sees is the TypeScript one.

## Things that will bite

- **Markdown saves are byte-preserving** (ADR-0003). An untouched block is written
  back from its original bytes. If you change how a block serializes, check the
  round-trip corpus in `packages/adapters/src/markdown`.
- **Anything that is not markdown needs a serializer handler** (ADR-0004). Left as
  text, remark escapes it: `[[Note]]` becomes `\[\[Note]]` the moment its paragraph
  is edited.
- **The index is derived and disposable.** Never store anything in it that is not
  already in the files.
- After `pnpm build`, **force a Rust rebuild** if only the frontend changed —
  `touch src-tauri/src/lib.rs` — or the binary keeps the old bundle embedded.
- **Prove every new assertion can fail.** Mutate the code, watch the test go red,
  restore. This project has shipped at least six that could not: one counted
  buttons in a container that always holds one; one asserted absence without
  first asserting the locator matched anything; one measured a 44px switch when
  the 114px control was what overlapped; one used only equal donut slices, which
  hid a moved contract because two halves are π either way.
- **A test that passes alone and fails under load is asserting on a moment
  rather than a state.** Wait for the condition (`expect.poll`, the `expectFile`
  helper in `e2e/host.ts`) instead of reading once.
- **Do not reimplement a card an agent is still working on.** Cancel it or wait.
  It has been done once here; the work was duplicated and the coordinator's copy
  was quietly worse.
- **Work budgets only go down.** A PR may lower `tools/perf/budgets.json` (and
  should, when it removes work); it never raises a number without James's explicit
  agreement. Over budget means the change made the app do more: find the work, don't
  move the number. A new host command, or a count that was 0, has no headroom at all.
- Plan and phases: `PLAN.md`. Decisions: `vault/docs/adr/`.
