# Coverage policy

Repo-wide floor: **70% of lines**, enforced in CI by `vitest --coverage`.

Coverage is not spread evenly. The slice below carries the risk — losing or corrupting
your notes, or silently answering a query wrong — and is held at **90%+ lines with every
rule tested**. Each entry gets its own threshold in `vitest.config.ts` as it lands.

| Module                      | Why it is high-impact                                                                         | Phase   |
| --------------------------- | --------------------------------------------------------------------------------------------- | ------- |
| `packages/domain/**`        | All product rules. Pure, so there is no excuse not to.                                        | ongoing |
| `adapters/markdown`         | Round-trip fidelity. Your files are at stake.                                                 | 2       |
| `domain/properties`         | Type and relation-target validation.                                                          | 5       |
| `domain/query`              | filter/sort/group → SQL compilation.                                                          | 6       |
| `application/indexing`      | File change → index delta correctness.                                                        | 4       |
| `application/vault`         | Safe write, atomic replace, conflict detection.                                               | 1–2     |
| `domain/schedule`           | Recurrence and critical path.                                                                 | 8, 11   |
| `domain/sources`            | Decides what gets written over your notes.                                                    | 12      |
| `domain/meetings`           | Decides whether a meeting is let in, what it says, and how its words are put right and back.  | 28      |
| `application/sources`       | Writes files into your vault from outside it.                                                 | 12      |
| `desktop/notes/*stranded*`  | Holds unsaved work the vault does not have, across a quit.                                    | 13      |
| `mcp/{connection,client}`   | Handles the API token; every failure an AI tool is told.                                      | 15      |
| `application/api`           | Writes into your vault on behalf of other programs.                                           | 15      |
| `application/artifacts`     | Writes a folder of files into your vault, from outside it.                                    | 17      |
| `application/types` (edit)  | Rewrites a type's file, and can rewrite every note of it.                                     | 17      |
| `application/types` (PARA)  | Writes PARA's type files into a vault, and adds to the vault's own.                           | 30      |
| `application/tags`          | Renaming a tag rewrites every note that uses it.                                              | 20      |
| `application/archive`       | Moves notes in and out of the Archive, rewriting frontmatter.                                 | 23      |
| `application/inbox`         | Moves notes out of the Inbox into a project's folder, rewriting frontmatter.                  | 30      |
| `application/gtd`           | Moves every task to GTD's statuses, rewrites views and rules, undoes it all.                  | 30      |
| `application/timeblocks`    | Reads each task's schedule; writes blocks and links tasks into them, undone.                  | 31      |
| `application/automations`   | Runs rules: archives or rewrites notes, writes Claude's proposals, logs it.                   | 25, 29  |
| `application/sync`          | Merges other Macs' changes into notes; settles conflicts; never loses a side.                 | U-29    |
| `application/meetings`      | Marks, archives and corrects meeting files that arrived, by itself; undoes corrections.       | 28      |
| `tools/n8n/*.ts`            | The n8n meeting mapper: commits files into your vault from outside DFAI.                      | 28      |
| `domain/terms`              | The vocabulary: decides how every name in a transcript is spelt.                              | 28      |
| `application/terms`         | Adds terms as notes and rewrites their variants in the frontmatter.                           | 28      |
| `tools/notion-import/*.ts`  | The Notion imports: meetings and a whole workspace into a vault, re-runnable.                 | 28, #79 |
| `tools/release/versions.ts` | Writes the version into every manifest, and the check CI and a release trust.                 | #481    |
| `application/proposals`     | Accepting a proposal writes notes, archives it, and undo takes them back.                     | 29      |
| `domain/highlights`         | Decides what a literature note's bytes become when a highlight is added, edited or removed.   | #503    |
| `application/highlights`    | Writes highlights into a literature note and takes them out, against the version read.        | #503    |
| `application/research`      | Reads every source and highlight for the Library and All highlights; a wrong read hides them. | #507    |
| `application/assistant`     | Answers what Claude tells James about a person or a meeting; a wrong read is a wrong answer.  | #35     |
| `application/reader`        | Copies a PDF or an EPUB into the vault with its note; writes the readers' highlights.         | #504/5  |
| `adapters/epub` (frame)     | Cleans an untrusted book and hands it to its opaque frame; every message across (ADR-0045).   | #505    |
| `application/meeting-links` | Writes a meeting's people and companies, and proposals, by itself; undone.                    | 29      |
| `application/profile`       | Reads who the vault's owner is, by name and address: whose a meeting's tasks are.             | #173    |
| `*/google-calendar`         | Connects your Google account and reads its answers; tokens stay in Rust.                      | 31      |
| `domain/granola`            | Granola's watermark, pacing and backoff: a wrong rule drops meetings.                         | 28      |
| `*/granola`                 | Writes files into your vault from outside it; turns Granola's JSON into domain types.         | 28      |
| `domain/kindle`             | Reads Amazon's notebook page into highlights; a wrong rule writes junk or drops highlights.   | #508    |
| `*/kindle`                  | Syncs Kindle highlights into source notes by itself; the Amazon session stays in Rust.        | #508    |

`src-tauri/src/kindle*` (#508) holds the Amazon session's cookies, and is held to
named tests the same way: no page or failure handed to the webview carries a
cookie value (against a fake notebook that echoes the `Cookie` header), nothing
is sent with no session, a URL off the notebook is refused, and a redirect off it
is handed back, not followed.

`src-tauri/src/granola*` (phase 28) holds the Granola key and no Rust coverage tool
exists here, so its bar is named tests, not a percentage: no answer or error carries
the key (each is serialised against a fake Granola that echoes `Authorization`), and a
path off `/v1/`, a non-GET method and a redirect are each refused.

Rules that apply everywhere:

- Coverage from tests with no meaningful assertion does not count.
- No snapshot test standing in for a behaviour test.
- A bug fix ships with the failing test that would have caught it, committed first.
- Tests are deterministic: seeded RNG, injected clock, no sleeps, no order dependence.
