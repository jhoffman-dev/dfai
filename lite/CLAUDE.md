# DFAI Lite — working notes

A fast markdown notes app over a GitHub repo. It is DFAI with everything but
the notes taken out: no tables, tasks, dashboards, custom types, assistant or
frontmatter. James's work now runs through Claude, so the vault is built to be
read and written by Claude as much as by the app.

It lives in `lite/` of the DFAI repo and shares nothing with DFAI at build
time: its own `package.json`, lockfile, config and CI workflow. It is not in
the pnpm workspace. Start sessions here: `cd lite && claude`.

## This file wins under `lite/`

A session here also loads the repo-root `CLAUDE.md` and James's user-level
rules. **For anything under `lite/`, this file is the authority.** The root
file's process (scoped gate, `tester`, `adversarial-tester`, draft PRs, ready
notes, keepers, flake rules, work budgets, the high-risk list) does not apply
here. James asked for that on 2026-11-21: nothing in this app is critical, and
a bug that is fixed and live in minutes costs less than a day of gates.

These are the explicit exceptions to his user-level rules, and why:

| Rule elsewhere                            | Here                                                                                             | Why                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| 70% coverage floor in CI, 90% on the core | No floor. Domain rules and sync are tested because those tests are cheap and catch real bugs.    | A floor is a gate; the gate was the problem. |
| Bug fix commits its failing test first    | A fix in `domain` or sync adds a test in the same commit. A UI fix needs none.                   | Speed of fix over proof of process.          |
| Unit, integration and e2e for every layer | Unit for domain, fake-GitHub tests for sync, one e2e smoke of the core loop.                     | One smoke catches "the app is broken".       |
| Review and attack passes before merge     | None by default. One `code-reviewer` pass when a change touches how notes are written to GitHub. | That is the one place a bug can lose a note. |

What still holds, unchanged: dependencies point inward, the Clean Code rules,
deterministic tests, report failures with their output, never claim something
works because it compiles. And from the root file: **this repository is
public**, so no real names of James's employer, clients, coworkers or family
in code, tests, fixtures or commits (use Larkspur Payroll, Mara Quill, Tobias
Fenn, `example.com`); his first name is James, never guessed.

## How a change ships

1. One ticket, one branch, one agent: `coder` for a feature, `bug-fixer` for a
   bug. Small things the coordinator does itself.
2. The author runs `pnpm check` (typecheck, lint, format, unit tests, build;
   it should stay under a minute) and, if a flow changed, `pnpm e2e`.
3. Open the PR ready, not draft. CI runs the `lite` workflow: the same check
   plus the smoke. The repo's `gate` check also runs, but for a change that
   touches only `lite/` it is the `static` job alone.
4. Green: the coordinator merges it (`gh pr merge --merge`). No ready note, no
   `pr-merger` sweep, no trial branch.
5. Broken on `main`? Fix forward or `git revert`, same flow.

Held for James to merge: a PR that touches anything outside `lite/` (the DFAI
rules for those paths apply), or anything that could rewrite or delete the
vault's history (a force-push, a bulk delete or move of notes).

The agents are the repo's own (`../.claude/agents/`, loaded here too). They
defer to this file, so where an agent's text says "failing test first, in its
own commit", "70% / 90%" or "hand the full gate to `tester`", the table above
replaces it. `tester`, `adversarial-tester`, `pr-review-fixer` and `pr-merger`
are available but not part of the flow; use one when James asks. Each agent
runs on the model its own file names: never pass a model override.

Tickets are GitHub issues on `jhoffman-dev/dfai` with the label `lite`.

## Commands

```sh
export PATH="/opt/homebrew/bin:$PATH"   # Node on James's Macs
pnpm dev        # the app at localhost, on a sample vault in memory unless a repo is connected
pnpm check      # typecheck + lint + format:check + unit tests + build
pnpm test       # unit tests only
pnpm e2e        # build, then the Playwright smoke (Chromium)
pnpm index      # write _index/ for a vault folder: pnpm index <path-to-vault>
```

## Shape of the code

One package. The layers are folders under `src/`, and ESLint holds the import
direction.

| Where             | What belongs there                                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `src/domain`      | The rules. Pure: no I/O, no clock, no randomness, no React. Links, tags, the vault tree, search ranking, the AI index, conflict copies. |
| `src/application` | Use-cases and the ports they need (`NoteStore`, `RemoteVault`, `Clock`, `SettingsStore`).                                               |
| `src/adapters`    | IndexedDB, the GitHub API, localStorage, the search engine. Thin: they translate, they decide nothing.                                  |
| `src/ui`          | React components. No rules: a component that decides what happens next is in the wrong layer.                                           |
| `src/app`         | The composition root: builds the adapters, hands them to the use-cases, mounts the UI.                                                  |
| `tools/`          | Node scripts that reuse `src/domain`: the index writer, the DFAI vault migration.                                                       |
| `vault-template/` | What a new vault starts with: its `CLAUDE.md`, folders, and the workflow that keeps `_index/` fresh.                                    |
| `skills/`         | Agent Skills for James's Claude account, so Claude finds and uses the vault from any product.                                           |

Stack: React 19, Vite, TypeScript (strict), CodeMirror 6 for the editor,
`markdown-it` + DOMPurify for the rendered view, MiniSearch, d3-force, zustand,
Vitest, Playwright. Plain CSS, one file per feature. Headless libraries only,
no component kit.

## How it works

- **Local first.** Every note is in IndexedDB. The app opens from there with
  no network, and a keystroke never waits on GitHub.
- **Sync is a background job.** Saves are queued and pushed as one commit
  through GitHub's Git Data API (blobs, tree, commit, fast-forward ref update,
  never forced), a few seconds after typing stops. A pull compares the remote
  tree to the last one seen and fetches only changed blobs.
- **A conflict never loses text.** If a note changed here and on GitHub since
  the last sync, the remote version stays at the path and this device's
  version is saved beside it as `<name> (conflict <date>).md`.
- **The index is derived.** Links, backlinks, tags and search are rebuilt in
  memory from the notes. Nothing lives only in an index.
- **No database.** The files are the data. A database would be a second
  source of truth that Claude cannot read from GitHub.

## The vault contract

`vault-template/CLAUDE.md` is the contract, written for Claude and people
alike; the app obeys the same rules. The short form:

- A note is a `.md` file. Its title is its file name. **No frontmatter.**
- Tags are inline `#tag` (nested `#area/topic`), anywhere outside code.
- Links are `[[Note name]]`, `[[Note name|shown text]]`, `[[Note#Heading]]`.
  Resolution follows Obsidian: a path if it has a slash, else that name
  anywhere, shallowest first. Typing a link to a note that does not exist and
  following it creates the note.
- Favourites are `.dfai-lite/favorites.json`: a list of paths, synced.
- `_index/` is generated (by the app on each push, and by a GitHub Action for
  anyone else's push). Never edit it by hand, never treat it as truth.
- Meetings land in `Meetings/<YYYY>/<MM>/<YYYY-MM-DD> <title>.md`.

A change to the contract changes `vault-template/CLAUDE.md`, the skill in
`skills/`, and the code together.

## Things that will bite

- **The browser has no Node.** `Buffer`, `process`, `node:fs` pass Vitest and
  fail in the app. `tools/` may use Node; `src/` may not (ESLint holds it).
- **The GitHub token is a secret.** It lives in this browser's storage only.
  Never log it, never put it in a URL, an error message or a commit.
- **Rendered markdown is untrusted.** A note can come from anywhere; the
  rendered view goes through DOMPurify, always.
- **Never force-push the vault** and never write a ref update with
  `force: true`. A refused push means pull, settle, push again.
- **Index output must be deterministic**: the same notes give the same bytes,
  whoever generates it. No timestamps, no machine names, sorted keys and paths.
- **Speed is the feature.** Opening a note, typing, and ⌘N must feel instant
  on a 2,000-note vault. Keep work off the keystroke path; virtualise long
  lists; build indexes incrementally, per changed note.
