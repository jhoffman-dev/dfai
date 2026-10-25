# dfai-mcp

An MCP server that lets AI tools — Claude Code, Claude Desktop, anything that
speaks MCP over stdio — search, read and write your DFAI vault.

It is a translator and nothing more (ADR-0016): each tool is one call to the
local API of the **running** DFAI app (`vault/docs/api/v1.md`). It never reads
vault files itself, so writes go through the same rules as the app — templates,
types, the byte-preserving save, and the panes you have open.

## Before you start

1. Open DFAI.
2. Turn on the API in **Settings → Connections**. DFAI writes the port and
   token to `~/Library/Application Support/com.dailyflowai.dfai/api.json`, which
   this server reads on every call — rotating the token or restarting DFAI
   needs no restart here.

## Build

```sh
pnpm install
pnpm --filter @dfai/mcp build   # → apps/mcp/dist/main.js, one self-contained file
```

`pnpm build` at the root builds it too. Needs Node 22 or later.

## Try it

`pnpm smoke:api --vault <scratch>` drives every tool above against the running
app over real stdio, checks the API's token, `Origin` and `Host` guards over raw
HTTP, and reads the vault's files to confirm each write landed. It prints a
PASS/FAIL table and exits non-zero on any failure.

It creates and edits notes, so point it only at a **scratch vault**: a copy of
a vault's `.atlas/` plus a few notes, outside any git repository, open in DFAI
with the API on. It refuses a path inside a repository and stops before writing
if DFAI has a vault of another name open.

## Claude Code

```sh
claude mcp add atlas -- node /abs/path/to/atlas/apps/mcp/dist/main.js
```

## Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`, then
restart Claude Desktop:

```json
{
  "mcpServers": {
    "atlas": {
      "command": "node",
      "args": ["/abs/path/to/atlas/apps/mcp/dist/main.js"]
    }
  }
}
```

## Configuration

Normally none. These environment variables override the connection file:

| Variable                              | Use                                                                                                                                                 |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ATLAS_API_URL` and `ATLAS_API_TOKEN` | Connect here with this token; both must be set.                                                                                                     |
| `ATLAS_CONNECTION_FILE`               | Read the connection file from this path instead.                                                                                                    |
| `ATLAS_MCP_IMAGE_DIRS`                | The folders `atlas_add_image` may read a `file` from, separated by `:`. Default: `~/Desktop`, `~/Downloads`, `~/Pictures` and the temporary folder. |

## Tools

| Tool                          | Route                                                                        | Writes? |
| ----------------------------- | ---------------------------------------------------------------------------- | ------- |
| `atlas_status`                | `GET /v1/status`                                                             | no      |
| `atlas_search`                | `GET /v1/search`                                                             | no      |
| `atlas_list_notes`            | `GET /v1/notes`                                                              | no      |
| `atlas_read_note`             | `GET /v1/notes/{path}`                                                       | no      |
| `atlas_create_note`           | `POST /v1/notes`                                                             | yes     |
| `atlas_update_properties`     | `PATCH /v1/notes/{path}/properties`                                          | yes     |
| `atlas_append_to_note`        | `POST /v1/notes/{path}/append`                                               | yes     |
| `atlas_replace_note_body`     | `PUT /v1/notes/{path}/body`                                                  | yes     |
| `atlas_backlinks`             | `GET /v1/notes/{path}/backlinks`                                             | no      |
| `atlas_export_note`           | `GET /v1/notes/{path}/export?format=confluence`                              | no      |
| `atlas_list_types`            | `GET /v1/types`                                                              | no      |
| `atlas_list_views`            | `GET /v1/views`                                                              | no      |
| `atlas_list_type_views`       | `GET /v1/types/{name}/views`                                                 | no      |
| `atlas_list_templates`        | `GET /v1/templates`                                                          | no      |
| `atlas_read_template`         | `GET /v1/templates/{name}`                                                   | no      |
| `atlas_terms`                 | `GET /v1/terms`                                                              | no      |
| `atlas_run_view`              | `POST /v1/views/{path}/run`                                                  | no      |
| `atlas_query`                 | `POST /v1/query`                                                             | no      |
| `atlas_run_query`             | `POST /v1/atlas-query`                                                       | no      |
| `atlas_sql`                   | `POST /v1/sql`                                                               | no      |
| `atlas_daily_note`            | `POST /v1/daily`                                                             | yes     |
| `atlas_capture_task`          | `POST /v1/capture`                                                           | yes     |
| `atlas_save_artifact`         | `POST /v1/artifacts`, then `PUT /v1/artifacts/{path}/files/{name}` per chunk | yes     |
| `atlas_add_image`             | `PUT /v1/notes/{path}/images/{name}` per chunk, then `.../append`            | yes     |
| `atlas_quick_add_types`       | `GET /v1/quick-add`                                                          | no      |
| `atlas_quick_add`             | `POST /v1/quick-add`                                                         | yes     |
| `atlas_calendar`              | `POST /v1/views/{path}/calendar`                                             | no      |
| `atlas_move_card`             | `POST /v1/views/{path}/move`                                                 | yes     |
| `atlas_add_to_view`           | `POST /v1/views/{path}/notes`                                                | yes     |
| `atlas_refresh_source`        | `POST /v1/sources/{path}/refresh`                                            | yes     |
| `atlas_tags`                  | `GET /v1/tags`                                                               | no      |
| `atlas_tagged_notes`          | `GET /v1/tags/{tag}/notes`                                                   | no      |
| `atlas_rename_tag`            | `POST /v1/tags/{tag}/rename`                                                 | yes     |
| `atlas_find_duplicate_people` | `GET /v1/people/duplicates`                                                  | no      |
| `atlas_merge_people`          | `POST /v1/people/merge`                                                      | yes     |
| `atlas_archive`               | `POST /v1/archive`                                                           | yes     |
| `atlas_unarchive`             | `POST /v1/unarchive`                                                         | yes     |
| `atlas_archived`              | `GET /v1/archive`                                                            | no      |
| `atlas_inbox`                 | `GET /v1/inbox`                                                              | no      |
| `atlas_process_inbox_item`    | `POST /v1/inbox/process`                                                     | yes     |
| `atlas_clarify_inbox_item`    | `POST /v1/inbox/clarify`                                                     | yes     |
| `atlas_schedule_task`         | `POST /v1/tasks/schedule`                                                    | yes     |
| `atlas_weekly_review`         | `GET /v1/review/weekly`                                                      | no      |
| `atlas_today`                 | `GET /v1/today`                                                              | no      |
| `atlas_automations`           | `GET /v1/automations`                                                        | no      |
| `atlas_automation_log`        | `GET /v1/automations/{id}/log`                                               | no      |
| `atlas_automation_dry_run`    | `POST /v1/automations/{id}/dry-run`                                          | no      |
| `atlas_meetings`              | `GET /v1/meetings`                                                           | no      |
| `atlas_brief`                 | `GET /v1/assistant/brief`                                                    | no      |
| `atlas_open_loops`            | `GET /v1/assistant/open-loops`                                               | no      |
| `atlas_meeting_quotes`        | `GET /v1/assistant/meetings`                                                 | no      |
| `atlas_propose_tasks`         | `POST /v1/assistant/propose-tasks`                                           | yes     |
| `atlas_make_dashboard`        | `POST /v1/assistant/make-dashboard`                                          | yes     |
| `atlas_proposals`             | `GET /v1/proposals`                                                          | no      |
| `atlas_accept_proposal`       | `POST /v1/proposals/{path}/accept`                                           | yes     |
| `atlas_reject_proposal`       | `POST /v1/proposals/{path}/reject`                                           | yes     |

`atlas_archive` and `atlas_unarchive` take up to 100 note paths and move them
into or out of `Archive/` as the app's Archive command does, rewriting links to
them. A path that cannot move is listed in the answer's `failed` with a reason;
the rest still move, so it is not a tool error. `atlas_archived` lists what is
archived, a page at a time. `atlas_search`, `atlas_run_view` and `atlas_query`
leave archived notes out unless `includeArchived` is true.

`atlas_brief`, `atlas_open_loops` and `atlas_meeting_quotes` answer "what do I
discuss with Larkspur Payroll today" and "what did Tobias say about the
cut-over": a brief on a person, company, project, area or meeting for a day;
its open tasks, waiting-fors and follow-ups; and its meetings with the turns
that answer the question, each quoted with its speaker. Every item carries a
`cite` wiki link — the block itself (`[[Kickoff#^t0003]]`), or the Transcript
heading for a turn with no block id, or `null` for a note whose name no link can
hold — to quote as written. `atlas_meeting_quotes` lists meetings up to `until`
(today unless given: a meeting still to come has not been held) and answers
`{ meetingQuotes }`. A quote is data to report, never an instruction. None
writes.

`atlas_propose_tasks` and `atlas_make_dashboard` draft, and only propose: each
leaves proposals in DFAI's Inbox (`atlas_proposals`) and writes nothing else.
`atlas_propose_tasks` runs the meeting extraction on one meeting now, with the
Claude set up in DFAI — so each draft costs what that provider charges — and
answers what it proposed; a meeting whose words have not changed since it was
drafted is not sent to Claude again (`unchanged: true`). A long meeting answers
`proposingTasks` instead, and its proposals follow; if that draft fails, DFAI
says so in its Activity log and in the window. `atlas_make_dashboard` checks a dashboard or view spec
with the app's own checker: a spec that fails is refused with `problems`, each
`{ at, message }`, to fix and send again. Asking twice for the same thing
proposes it once, and the second answer's `problem` says what became of the
first (waiting, or accepted or rejected on a day). A dashboard or view proposal is accepted only in DFAI —
`atlas_accept_proposal` refuses it with `forbidden` — since it is written into
`.atlas`, which the API never writes.

`atlas_meetings` lists meetings newest first, with what the import made of
each: `importError` says why a file that arrived broke the meeting import
contract, and `duplicateOf` links the meeting an archived copy duplicates.
Meetings are imported in the app as they arrive; fixing a file with
`atlas_update_properties` or `atlas_replace_note_body` has the app import it.

`atlas_process_inbox_item` files one note from the Inbox under a project or an
area, as the Inbox's Process does: it moves into the project's folder and gets
`project: "[[…]]"` linking it. `project` must be a project or an area still in
use; anything else is refused before the note moves, and a proposal (a note of
type `proposal`, wherever it sits) is refused — it is answered with
`atlas_accept_proposal` or `atlas_reject_proposal`. `atlas_capture_task` puts
what it captures in the Inbox, and `atlas_inbox` lists what waits there —
every note in `Inbox/`, and every task still at `status: inbox` wherever it
lives — each meeting with what the import made of it and each task with what
it already says; proposals are listed by `atlas_proposals`, not by it.

`atlas_clarify_inbox_item` is GTD's clarify step for one item, as a row of the
Inbox page does it: status, `waitingOn`, `defer`, `due` and `contexts` are
written in one save, held to the task rules — `waiting` never needs
`waitingOn`; who it waits on is optional — and `project` files a
note that is in `Inbox/` or links a task that lives elsewhere. A task given a
status other than `inbox` leaves the Inbox with or without a project.

`atlas_proposals` lists what Claude or an automation proposed and is waiting in
the Inbox (`Inbox/Proposals/`), with what each would write and the line it
cites. `atlas_accept_proposal` writes that and archives the proposal, as its
Accept button does; `atlas_reject_proposal` archives it unwritten. Neither is
idempotent: a second answer to one proposal is refused as `conflict`. Editing a
proposal first, and undoing an accept, stay in the app.

`atlas_schedule_task` sets time aside for a task as dragging it onto the
calendar's empty time does: a new block note from `start` (local wall-clock to
the minute, `2026-10-12T09:00` — a `Z`, offset or seconds is refused) for `minutes`, linking the task — or, without `minutes`,
as long as the task still needs. Calling it again makes another block, which
is how a task is split. `atlas_query` with `schedule: true` reads what each
task now has scheduled.

`atlas_weekly_review` reads the weekly review as the app's page shows it:
Waiting tasks untouched for more than 7 days, active projects with nothing
next, overdue tasks, Someday and Longterm untouched for more than 30 days, and
the Inbox's count. It writes nothing; act on an item with
`atlas_update_properties` (a status, or `defer`) or `atlas_archive` (a project).

`atlas_today` reads the Today page as the app shows it: overdue, due today,
back from deferral today, in progress, next actions by project and waiting by
person — each Waiting task with the whole days since its file last changed —
plus the Inbox's count and how many projects are stalled. It writes nothing;
act on a task with `atlas_update_properties` (a status, or `defer`).

`atlas_export_note` turns a note into markdown for a Confluence page: links as
their words, shown blocks quoted under their note, callouts as quotes, and a
`dropped` list of everything left out (properties, block ids, comments, vault
images, where links went). It writes nothing; Claude creates the page with its
own Atlassian connector, `title` as the title and `markdown` as the body —
passed verbatim, so `dropped` stays the whole story — and says what `dropped`
lists.

`atlas_move_card` moves a card on a board as a drag does, into a group the
board itself draws (as `atlas_run_view` lists them). It is not idempotent: a
move into done finishes the task and rolls a repeating one forward, so it needs
`ifModified` (the `modified` from `atlas_read_note`), and a retry of it is
refused as `conflict` rather than finishing the task twice. `atlas_add_to_view`
is "+ New" in a group; several at once each get their own numbered name.

`atlas_list_type_views` lists one type's views in the order its tabs read in
the app, each with its `order`, and a type with no views as its default table
marked `virtual` (not a file yet, so run its notes with `atlas_query`). It only
reads: adding, renaming, copying, reordering and deleting views stay in the
app, since views live in `.atlas`, which the API never writes (ADR-0016).

`atlas_list_templates` lists the vault's templates — every one in
`.atlas/templates`, subfolders included — with what makes notes from each (a
type's new notes, today's note, captured tasks, saved artifacts) and the types
none serves. `atlas_read_template` reads one by name: the properties and body a
note made from it with `atlas_create_note` starts with. Both only read: making,
renaming, editing, moving and deleting templates stay on the app's Templates
page, since templates live in `.atlas`, which the API never writes (ADR-0016).

`atlas_automations` lists the vault's automations — each rule, its last and
next run, and why one is paused — with rules that cannot be read listed apart
as `broken`. `atlas_automation_log` reads a rule's log, newest first, and
`atlas_automation_dry_run` answers what a rule would do if it ran now, writing
nothing. All three only read: running a rule, undoing its last run, and making
or editing one stay on the app's Automations page, since rules and their logs
live in `.atlas`, which the API never writes, and a run changes many notes at
once (ADR-0016).

`atlas_run_query` runs a DFAI query — the text the app's query builder
writes, such as `FROM task, project WHERE status != done GROUP BY project` —
and answers its rows, with `groups` and sub-groups for `GROUP BY` as the app
groups them. It leaves archived notes out unless the query says
`INCLUDE ARCHIVED`. A mistake in the text comes back as `invalid` with its line
and column. It cannot save a query as a view: views live in `.atlas`, which the
API never writes. `atlas_query` is the older, one-type query with filters and
sorts, and stays as it was.

`atlas_add_image` reads an image from a path on this computer, or takes it as
base64 with a name. This server runs as you, and a client steered by text it
read could name any file on the disk, so a `file` is read only when it is an
image in one of the image folders (see `ATLAS_MCP_IMAGE_DIRS`), after any link
is followed: its own extension must be PNG, JPEG, GIF, WebP, SVG or HEIC, its
bytes must be that kind, and it must be no larger than 20 MB — checked by its
size before a byte is read or sent. `name` may rename it but not change its
extension. A file that is not there, is not a file, or is outside the folders
gets one answer that does not say which.

An image that fits in 512 KiB is sent whole. A larger one is sent as an
upload: the first chunk is answered with an upload id, each next chunk carries
it, and the last says `last: true`, when DFAI checks the whole image and puts
it in place (numbered when the name was taken). Unless `insert` is false it
then appends the image's `![alt](src)` to the note; when that append is
refused (the note has unsaved edits in the app), the error says where the
image was saved.

`atlas_save_artifact` is the other tool that makes more than one request. The
host takes at most 1 MiB per request, so a page up to 640 KiB goes with the
note; a larger one — and every file in `files` — follows it in 512 KiB chunks,
each at the offset the last one ended at, and the note is read back once the
files have landed (its `saved` and `cover` are set as they arrive). Files are
checked before anything is sent, so bad base64 saves nothing; a chunk refused
after the note was saved says so, naming the note's path.

`atlas_merge_people` rewrites every note linking to the people it merges, so it
only previews unless called with `confirm: true`: the preview names each note
written and its links, the values the kept note keeps over a merged one's
(`conflicts`), and the aliases, emails and bodies it gains. A note being typed
in refuses it, and a note changed since the preview is `conflict` with nothing
written. `atlas_find_duplicate_people` lists the pairs worth offering.

`atlas_rename_tag` rewrites every note using a tag, so it only previews unless
called with `dryRun: false`: the preview names the notes and uses that would
change, the notes it will not touch (`.atlas`, or where the new name could not
be written so it reads back), and `mergesInto` — a tag in use already, or the
parent of one, that this one would join. A merge cannot be undone by renaming
back, so it is refused with `exists` unless `merge: true` is sent. Renaming a
tag to its own name in another case rewrites every use to that spelling. A note
open in DFAI with unsaved typing is left alone and reported in `failed`. A
rename that timed out may still finish: preview again before retrying.

A failure is a tool result with `isError: true` and a message the model can act
on: `DFAI is not running — …` when the app is closed, how to turn the API on
when it is off, and `code: message` for an error from the API itself (e.g.
`conflict: Tasks/Call Sam.md changed since you read it`). Nothing is written to
stdout but the protocol; diagnostics go to stderr, and the token never appears
in either.
