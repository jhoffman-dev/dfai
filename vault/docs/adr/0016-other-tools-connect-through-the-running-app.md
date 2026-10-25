---
type: adr
status: accepted
date: 2026-09-22
---

# Other tools connect through the running app

## Context

James wants other tools — Claude Code, Claude Desktop, scripts, Raycast — to read
and write the vault through Atlas: search it, read a note, create one from a
template, set a property, capture a task, run a view. Two shapes were asked for:
a plain **API** anything can call, and an **MCP server** AI tools can start.

The files are already open to anything. What another tool cannot get by reading
the folder is what Atlas knows: the types and their properties, templates, the
index, saved views, and — the one that matters most — which notes are open in a
pane right now with edits not yet saved.

Three places the API could live were weighed:

1. **Inside the running app.** A localhost server in the Rust host that
   authenticates a request and hands it to the webview, where the same
   TypeScript use-cases the UI uses answer it.
2. **A headless sidecar** that loads the vault itself and works with the app
   closed.
3. **The MCP server reads the folder directly**, with no API at all.

## Decision

**The API is served by the running app, and the MCP server is a thin translator
onto it.**

- The Rust host listens on `127.0.0.1` only. It checks the token, the `Host`
  header and the body size, then emits the request to the webview and waits for
  the answer. It decides nothing about what the request means (ADR-0005): the
  router and every rule behind it are the TypeScript that already runs the UI.
- REST under `/v1` is the single contract, typed in
  `packages/application/src/api/contract.ts` and described for people in
  `vault/docs/api/v1.md`.
- `apps/mcp` is a Node program speaking MCP over stdio. Each tool is one REST
  call. It holds no rules, reads no vault files, and finds the app through the
  connection file.

Why in-app rather than a sidecar: **a write to a note that is open in a pane must
go through that pane.** The board already does this for drags
(`setPropertiesIfOpen`, `reloadOthers`), because writing the file behind an open
editor is how edits get lost — the editor saves its older copy over it. Only
code in the same process as the panes can see them. A sidecar would either write
behind them or need its own channel into the app, which is this design with
more parts. The price, accepted: **Atlas must be running** for the API to
answer, the same bargain Obsidian's Local REST API makes. A headless mode can be
added later behind the same contract without any caller noticing.

Why not option 3: it would reimplement types, templates, frontmatter editing and
the byte-preserving save in a second program, which is the drift ADR-0005 exists
to prevent, and it would still write behind open editors.

## Security model

A localhost port is reachable by every process on the machine and, through DNS
rebinding, by any web page open in a browser. So:

- **Off by default.** Turned on in Settings, per machine.
- **Bearer token** on every request, 32 random bytes as hex, compared in
  constant time. Rotating it in Settings invalidates the old one at once.
- **Bound to `127.0.0.1`,** never `0.0.0.0`.
- **`Host` must be `127.0.0.1:<port>` or `localhost:<port>`** — this is what
  defeats DNS rebinding, where a page's own domain resolves to `127.0.0.1`.
- **Any `Origin` header is refused.** Browsers send one; the tools this is for
  do not. There is no CORS, so no page can read an answer even by accident.
- **A request target that names a host is refused** (`GET http://…/v1/…`,
  absolute form): RFC 9112 makes that authority, not `Host`, the request's
  host, so the `Host` check could otherwise be judging the wrong thing.
- **Bodies over 1 MiB are refused** before they are read into memory.
- **Connections are bounded (A15-01).** At most 32 are open at once; more wait
  in the kernel's accept queue until one closes, costing the app no file
  descriptors. Each connection takes no new request after 60 s and is closed
  60 s after that whatever it is doing — longer than any legitimate request
  (10 s headers + 10 s body + 30 s answer), so only a stalled client, such as
  one that stops reading its answers, is ever cut off. Without this any local
  process could exhaust the app's descriptors and make vault saves fail.
- **Only a token holder keeps a connection (R15-02).** Every refusal the host
  makes before the router sees a request — 400, 401, 403, 404, 413 — is sent
  with `Connection: close` and the connection is closed, so a caller without
  the token cannot pipeline refused requests or sit on a slot. Availability
  against local processes is otherwise out of scope: a process running as the
  same user can kill Atlas outright, and loopback gives no per-peer identity
  to account connections against, so the bounds above protect the app's
  descriptors, not a fair share of the API.
- **The connection file** — port, token, version — lives in the app's data
  directory (`~/Library/Application Support/<bundle id>/api.json`) with mode
  `0600`. **Never in the vault**: vaults get synced and shared, and a token in
  one is a token published. A file found readable by anyone else (restored
  from a backup, copied by hand) is made `0600` again **and its token
  replaced**, since it may already have been read.
- **A taken port replaces the token.** When Atlas starts with the API on and
  its recorded port is held by another process, that process may have been
  collecting the token from tools knocking there while Atlas was closed. Atlas
  replaces the token before serving on the port the OS gives it, and logs that
  it did (never the token). Clients connect to `127.0.0.1` literally.
- **Turning the API on or off is all-or-nothing.** If the connection file
  cannot be written, nothing changes: a turn-on serves nothing, and a turn-off
  leaves the API on and says so, rather than the file and the server
  disagreeing.
- **No delete and no rename in v1.** Every write is additive or guarded:
  `PUT .../body` requires `ifModified`, a body write to a note with unsaved
  edits in the app is refused with `unsaved_in_app`, and SQL runs on the
  index's read-only connection under a row cap and step budget.
- Each request is bound to the vault open **when it arrived** (R14-01's
  `inVault`); a vault switch mid-request makes its write refuse rather than
  land in the other vault.

## Consequences

- One contract, three builders: router, host and MCP server can be written in
  parallel against the same types.
- Every new capability the UI gains is an API route away, with no rule copied.
- The app being closed is a clean `ECONNREFUSED`, which the MCP server turns
  into "Atlas is not running" rather than a stack trace.
- A long request holds a webview task; the host gives up after 30 seconds with
  `timeout` so a stuck handler cannot hold a caller forever.

## Later routes (2026-09-27)

Images for notes, calendar ranges, quick add and source refresh were added on
these terms, unchanged. An image is written a chunk at a time like an
artifact's files, never over a file, and never into the note: the caller adds
its markdown with the guarded body routes. A source refresh is the one route
that reaches outside the vault; it runs the app's own refresh bound to the
request's vault, so ADR-0017's host-side binding decides where any secret goes,
and nothing about secrets is readable. What stays out — writes into `.atlas`
(types, views, dashboards, settings), moves and deletes, secrets, picking a
file — is listed in `vault/docs/api/v1.md`, with why.

## Hardening (A20-02, 2026-09-27)

An adversarial pass found the terms above too loose in four places. Each is
now closed where the rule belongs:

- **A source that spends a secret runs only from `.atlas/sources`.** The
  binding in ADR-0017 checks the host a secret goes to, not the path, so a
  note the API wrote in user space could spend the user's token on any page of
  that host and read the answer back. Such a source — and one reading a SQLite
  file outside the vault — refreshes only from `.atlas/sources`, which the API
  cannot write; elsewhere the route answers `forbidden` and fetches nothing,
  and the pane says to move it into System → sources. The API refreshes one
  source at most every 30 seconds (`conflict` with `retryAfter`).
- **A chunked image is staged, never appended into the vault.** Its first
  chunk (`last: false`) goes to `.atlas-cache/uploads/<id>`, answered with an
  id no one can guess; every next chunk must carry it; the last (`last: true`)
  has the whole image checked and moved into place under a free name. A chunk
  past offset 0 without a valid id is refused, so no caller can add to a file
  it did not start. An abandoned staging file is inert (the cache is
  disposable; nothing prunes it yet). An image that fits in one request is
  saved at once, as before. Artifact files keep their offset contract: they
  land in a copy folder the API made for the note, and moving them to staging
  would change the thumbnail flow for no gain on this card.
- **An SVG must be a picture.** Its root element must be `<svg`, and an HTML
  doctype, `<html`, `<script` or an `on…=` handler anywhere refuses it.
- **A link cannot carry a path into a hidden folder.** The API keeps callers
  out of `.atlas` and `.git` by what a path says; the host now refuses any
  path whose canonical form lands in a hidden top-level folder the path did
  not name, so `Notes/settings.md` linked to `.atlas/settings.md` is refused,
  for the app as well as the API.

`atlas_add_image` is a confused deputy by nature — the MCP server reads the
disk as the user for a client that may not be able to. It reads a `file` only
under `~/Desktop`, `~/Downloads`, `~/Pictures` or the temporary folder
(`ATLAS_MCP_IMAGE_DIRS` overrides), after resolving links, when its own
extension is an image kind, its bytes are that kind, and `stat` says it is at
most 20 MB — before any byte is read or sent. `name` cannot change the kind.
A file that is missing, not a file, or outside the folders gets one answer.

## Tags (Phase 20, 2026-09-27)

Listing tags, the notes using one, and renaming one were added on these terms.
Renaming a tag is not the rename v1 leaves out: no file moves, and what it
writes is notes' text in user space, the class `PATCH .../properties` already
is. It runs the tags page's own use-case, so every note is read again and
written byte for byte against the version it read. Three things differ from
the page, because the caller is not the person at the keyboard:

- **A note being typed in is left alone and reported**, never flushed: the page
  saves its own pane's typing first, but a request from outside must not save
  what someone is still writing, as it may not write a body under it.
- **`.atlas` and hidden folders are never written.** A template's `tags:` is
  listed as skipped; the rename reaches user space only.
- **A merge must be asked for.** Renaming into a tag already in use joins the
  two, and renaming back cannot part them, so it is refused with `exists`
  unless the request says `merge: true`; `dryRun` shows `mergesInto` first.
  A tag used only as the parent of others is in use (renaming `#alpha` to
  `#beta` when `#beta/y` is written is a merge). Renames in a vault run one at
  a time through one queue the tags page shares, and the merge is asked again
  just before writing, counting names earlier renames wrote that the index has
  not caught up with (A20-04).
- **Tags are counted in user space.** The tree, a tag's lookup and its notes
  read only the notes the API reads, so a tag only a template uses is
  `not_found`, as its notes are left out of `/v1/notes`.
- **A timed-out rename may still finish.** The rename writes note by note and
  does not stop when the caller stops waiting; a caller checks with
  `dryRun: true` before retrying. The MCP tool previews unless told
  `dryRun: false`.

## Amendment: the Archive is the one move (A20-06, 2026-09-27)

"No delete and no rename in v1" gains one exception: `POST /v1/archive` and
`POST /v1/unarchive` move notes. They are the only routes that do, and they are
held to these limits, so that a caller can file a note away and bring it back
but cannot use them to put a note anywhere it likes:

- **User space only.** Every path named is a `.md` note outside `.atlas` and
  hidden folders — the pruned names (`node_modules`…) matched in any case, as
  the disk matches them.
- **Never over anything.** Each move is an exclusive rename: the host refuses a
  destination that exists, and a taken name is numbered first (`X 2.md`).
- **The destination is fixed by the note's own path.** Archiving files
  `P` at `Archive/P`; unarchiving puts `Archive/P` back at `P`. The note's
  `archivedFrom` is used only to spell that same place as it was (another case
  or composition, or without the number archiving gave a clashing name). An
  edited stamp — through `PATCH .../properties`, `POST /v1/notes` or by hand —
  cannot send a note to another folder, give it another name or extension, or
  make folders anywhere but on the way to that place. A note whose place in the
  Archive would be deeper than the host's walk reads (`VAULT_WALK_DEPTH`, a
  domain constant handed to the host with the skip list, ADR-0014) is refused.
- **At most 100 paths** a request.
- **Typing is never saved for anyone.** A note open in Atlas with unsaved
  typing is not moved or stamped, and a note linking to a moved one that has
  unsaved typing is not rewritten; each is reported in `failed` with
  `code: "unsaved_in_app"`. The app's own Archive command runs the same
  use-case with the typing saved first, because there the person asked.
- Every note left unmoved or not fully updated — a link rewrite that failed,
  unreadable YAML — is named in `failed`, and a vault switch part-way still
  answers the moves already made.

## Atlas queries (Phase 24, 2026-09-27)

`POST /v1/atlas-query` runs an Atlas query (ADR-0019) on these terms,
unchanged: it names its vault, reads only, and runs through the same checked,
bound, read-only path as the query builder. A query's text is refused over
200,000 characters or 2000 conditions; its rows are 1 to 5000, the text's own
`LIMIT` winning when smaller. Archived notes are included only by the text's
`INCLUDE ARCHIVED` — the route takes no `includeArchived` of its own. Saving a
query as a view is not a route: a query view is a note in `.atlas/views`, which
the API never writes.

`context` (P30-04, 2026-10-08) names the note `this` in a query means. It is a
note path in user space, as any path the API takes, spelled as the vault spells
it, and must exist — `not_found` otherwise. Nothing of the note is read or
written; its path is bound like any value in the query.

## Automations are read, not run (Phase 25, 2026-09-27)

Automations get three routes, all read-only: `GET /v1/automations` (every rule,
its last and next run, and why one is paused or broken),
`GET /v1/automations/{id}/log`, and `POST /v1/automations/{id}/dry-run`.
Running a rule, undoing its last run, turning one on or off, and making,
editing or deleting one stay in the app. Why:

- **Rules and logs live in `.atlas`, which the API never writes.** A rule is a
  standing order: a caller that could write one could have the vault archived
  or rewritten on a schedule, long after the call and with no one asked. The
  log is what undo reads to put notes back; a caller that could write it could
  have undo put back something that was never there.
- **A run changes many notes at once.** One run moves or rewrites up to 500
  notes, and the app runs rules one at a time, logs each run, and offers its
  undo on the page that reports it. A run from outside would do the same with
  no one watching that page, while the app's own clock may be running another
  rule. Anything a rule does to a note can still be done note by note through
  the routes that exist — `POST /v1/archive`, `PATCH .../properties` — each
  under its own guards.

The dry run is the one POST that writes nothing: it runs `planRun`, the same
use-case the app's Dry run and every run plan with, and reads only the notes
and the index. Every route names its vault and answers `no_vault` if another is
opened while it reads; a query the rule holds that does not read, or that the
index refuses, is `query_failed` with this machine's paths taken out. What only
the app's runner knows — when it began watching the vault, and which rules its
clock has paused — is read through a port the app fills (`AutomationClock`),
for the request's vault only, so a rule's next run and pause are the ones the
Automations page shows.

## A view's groups: read, moved into, added to (issue atlas-archive#6, 2026-10-03)

Saved views gained a sub-grouping (`subGroupBy`: a table's sub-groups, a
board's swimlanes). The API follows on the same terms as every route above —
each names its vault, hands out no secret, and writes through the
byte-preserving property and create paths:

- **Read.** `GET /v1/views` names each view's `groupBy` and `subGroupBy`, and
  running a grouped view answers its groups and sub-groups as the app draws
  them (`groups`, shaped as an Atlas query's).
- **A card moved on a board** is `POST /v1/views/{path}/move`. Its completion
  rule — which property finishing means, and rolling a repeating task forward
  once — is `cardMoveChanges`, the one the board's drag calls; the route only
  reads the view, its type and the note, and never decides it again. A group
  is one the board draws, matched by `groupKeyOf` — the key the board's own
  columns are drawn by — and written typed by its property's kind (`movedValue`,
  which the drag uses too). A group the card is already in is left out of the
  write, as a drag within a column writes nothing. That alone does not stop a
  retry: a finished repeating task is back in its first status, so the same
  move would finish it again. A move that finishes a task therefore requires
  `ifModified`, which makes the retry a `conflict`, and the MCP tool is not
  marked idempotent. Only a board's cards move — never a view or dashboard
  note, whose `type:` names what it lists; anything else is a property write,
  which the API already has.
- **A note added in a group** is `POST /v1/views/{path}/notes`, given the
  group's values typed by `groupValueProperty`, the rule "+ New" uses.
- **Not a route: changing a view's grouping.** A view is a note in
  `.atlas/views`, which the API never writes; a caller that could regroup one
  could rewrite the views James keeps in his sidebar. Grouping, like the rest
  of saved-view editing, stays in the app.

## A type's views: read, not changed (issue atlas-archive#11, 2026-10-04)

A type now owns its views, shown as tabs a person can add to, rename, copy,
drag into another order and delete (ADR-0023). The API follows on the same
terms as every route above:

- **Read.** `GET /v1/types/{name}/views` answers a type's tabs in the order
  the app draws them, each with its `title`, `layout`, `path` and `order:`,
  and — for a type with no views — the virtual default table, marked
  `virtual`, under the name and path the app would write it to. The route
  only reads the sidebar catalogue and the types; which views a type owns,
  their order and the default's name are `typeViews` and `defaultViewTab`,
  the rules the tabs use, never decided again. It names its vault, and answers
  `no_vault` if another is opened while it reads. Asking writes nothing, the
  default included: ADR-0023 keeps a look from writing to a synced vault.
  `GET /v1/views` names each view's `order` beside its `title`.
- **After its review (same day).** The default's name is checked against one
  list, `takenViewPaths`, which the route, the app's tabs and the app's write
  all use: every entry in `.atlas/views` (from the folder's listing, so a
  note that is no view still holds its name, and a view lifted to Today or
  Inbox is not missed) and every view found elsewhere, compared in any case
  and in NFC, as APFS compares. The route pages by `limit` and `offset` with
  a `total`, as `/v1/archive` does — tab order is not path order, so a path
  cursor cannot mark a page's end. `GET /v1/views` now lists Today and Inbox
  too, first: they are views, and a caller could not otherwise find their
  paths to run. `order: "0x10"` is no order: only a plain decimal counts.
- **Not routes: adding, renaming, copying, moving and deleting a type's
  views.** Each is a write into `.atlas/views`, which the API never writes.
  Why each stays in the app:
  - _Adding and copying_ make a new file in `.atlas/views`, and the first
    change to a type with no views writes its default table as well. A caller
    that could make views could fill the sidebar James keeps, and a copy is a
    byte-for-byte duplicate of whatever a view holds — its SQL included.
  - _Deleting_ is a delete, and v1 has none (Security model): the app's
    delete goes through its usual question, to the Trash.
  - _Renaming and moving_ write one key of an existing view — `title:` or
    `order:` — and are the only candidates for an exception. They change how
    the tabs read, not what a view lists. But the rule is drawn by path, and
    enforced twice by path (the router, and the host's hidden-folder check):
    letting these through means a key allowlist inside `.atlas`, a new kind of
    guard that must refuse `type:`, `filters`, `sql:` and every other key that
    changes what a view means, and a move may renumber several views at once
    (`movedViewOrder`) — a write to many `.atlas` files from one call. Renaming
    the virtual default would also create a file there.

  So the API stays read-only for views. A view kept outside `.atlas` is an
  ordinary note: its `order:` and `title:` can be written with
  `PATCH /v1/notes/{path}/properties` like any other note's, as they always
  could; the tabs read whatever is there.

- **Proposed, not accepted: a narrow write for rename and reorder.** If James
  wants an agent to tidy a type's tabs, the exception would be one route,
  `PATCH /v1/types/{name}/views/{path}` taking `{ title }` or `{ to }` and
  nothing else, running the app's own `renameTypeView` / `moveTypeView`
  use-cases (so `movedViewOrder` decides what is written), byte-preserving,
  requiring `ifModified` for the moved view, refusing a virtual default
  (nothing in `.atlas` is created), and refusing any path that is not a view
  the named type owns. Adding, copying and deleting views stay in the app
  either way. Until this section is amended to accept it, nothing writes
  `.atlas/views` through the API.

## Templates: read, not written (issue atlas-archive#16, 2026-10-04)

Templates now have a page of their own and are never notes (ADR-0026): the
Templates page lists each with what makes notes from it, and makes, renames,
edits, moves to notes and deletes them. The API follows on the same terms as
views above:

- **Read.** `GET /v1/templates` lists every template — every markdown file
  under `.atlas/templates`, `.md` or `.markdown`, subfolders included — with
  its `uses` (a type's new notes, today's note, captured tasks, saved
  artifacts) and the types no template serves. `GET /v1/templates/{name}`
  answers one template's parsed properties and its body byte for byte. The
  routes only read: the catalogue is `loadTemplateCatalog` and what a
  template is for is the domain's `templateUses`, the rules the page uses;
  which template a name means is `findTemplateNamed`, the lookup
  `POST /v1/notes { template }` makes, so reading one by name answers what a
  note made from it starts with. Both name their vault and answer `no_vault`
  if another is opened while they read.
- **A name is matched as the disk matches it.** `findTemplateNamed` now
  compares through the domain's `isTemplateNamed` — trimmed, in any case and
  either Unicode normalisation — the comparison `isTemplateFor` already made.
  Before this, `POST /v1/notes { template: "Café" }` sent decomposed missed a
  `Café.md` written composed, though the Mac's disk takes the two for one
  file.
- **After its review (same day): which of two templates a name means.**
  Templates were sorted by `localeCompare` on their names, with depth only
  breaking exact ties, so of `Meeting.md` and `Old/meeting.md` (or
  `Old/ Meeting.md`) the deeper one sorted first and the case-folding lookup
  took it — the read route and `POST /v1/notes` both started from the
  subfolder's file. The order is now the domain's `compareTemplates`: by the
  name as lookups fold it, in one fixed locale, then nearer the top, then as
  written. The Templates page and the app's lookups read the same order.
- **No note route hands out a template.** Every note route already kept to
  user space (`isApiNotePath`), so a template was never a note here; tests now
  pin it for the notes list, search hits and backlinks the index still holds,
  and a template path asked for as a note.
- **Not routes: making, renaming, editing, moving to notes and deleting a
  template.** Each writes `.atlas/templates`, which the API never writes.
  Why each stays in the app:
  - _Making and editing_ decide what every new note of a type, today's note
    or every captured task starts as. A caller that could write a template
    could put text or properties into notes made long after the call, by
    James, with nothing saying where they came from.
  - _Renaming_ can detach a template from what uses it, since the name is
    what ties it to a type (ADR-0026); the page warns while the name is
    typed. A route would do it silently.
  - _Deleting_ is a delete, and v1 has none (Security model).
  - _Moving to notes_ is the one candidate for an exception: it moves a file
    out of `.atlas` into user space, bytes untouched, and is the way out for
    a note saved over a template by mistake (issue atlas-archive#15). But it is a move of
    a file the API cannot otherwise name, and a caller that moved the Person
    template out would leave new Person notes starting empty.

  So the API stays read-only for templates. `POST /v1/notes { template }`
  still makes notes from them, as it always could.

- **Proposed, not accepted: move to notes.** If James wants an agent to clear
  up a note saved over a template, the exception would be one route,
  `POST /v1/templates/{name}/move-to-notes`, running the app's own
  `moveTemplateToNotes` (numbered at the root, bytes untouched, never over a
  note), answering `{ note, lost }` with the uses it ends, and taking
  `ifModified` so it moves only the template the caller read. Making,
  renaming, editing and deleting templates stay in the app either way. Until
  this section is amended to accept it, nothing writes `.atlas/templates`
  through the API.
- **Later: "New <type>…" in relation pickers** (issue atlas-archive#15, another branch)
  makes a note of a type and links it from the note being edited. When it
  lands, the API/MCP keeper decides whether it is a route of its own or
  `/v1/quick-add` followed by `PATCH /v1/notes/{path}/properties`, which
  callers can already do.

## Terms: the vocabulary is read, terms are notes (issue #11, 2026-10-08)

Terms now have a page of their own (P28-05): a term is a note of type `term`
— its title the right spelling, `variants` the ways a notetaker mishears it —
and a Person's or a Company's `aliases` are other spellings of their name
(only for linking people; the vocabulary leaves them out, ADR-0027).
The API follows on the same terms as every route above:

- **Read.** `GET /v1/terms` answers every term, the vocabulary (every
  spelling Atlas puts right, longest first, with the notes that claim it) and
  the conflicts (a spelling two notes claim for two right spellings, which is
  not used). It runs `loadTerms`, the use-case the Terms page runs, and the
  domain's `vocabulary` decides what is a spelling, what is a conflict and in
  what order; nothing is decided again in the route. The notes are read from
  the index by the domain's compiled query, which keeps to user space
  (`userSpaceNoteSql`) and out of the Archive, so no template, hidden note or
  retired term is handed out. A note counts when any item of its `type` is
  a term, person or company — as `@` and a type's page count it — and as
  the first of them it names. It names its vault, answers `no_vault` if
  another is opened while it reads, and writes nothing.
- **Not a route: writing a term.** A term is an ordinary note in user space,
  so it is written as one: `POST /v1/notes` with `type: term` adds it, and
  `PATCH /v1/notes/{path}/properties` changes its `variants` or a person's
  `aliases` — byte-preserving and guarded by `ifModified` as every note write
  is. A route of its own would be a second way to write the same frontmatter.
- **MCP.** `atlas_terms` is the route, read-only; its description points a
  model at `atlas_create_note` and `atlas_update_properties` for writing, and
  tells it never to correct a spelling in conflict.

## Amendment: processing the Inbox is the second move (P30-01, 2026-10-08)

The Inbox's **Process** files a note under a project or an area: it moves
into the project's folder and gets `project: "[[…]]"` linking it. An agent
triaging the Inbox needs it, so `POST /v1/inbox/process` (MCP
`atlas_process_inbox_item`) is the second route that moves notes. It runs the
app's own `processInboxItems`, on the same move-and-stamp as the Archive, and
is held to the Archive's limits above, with one change to where a note goes:

- **Only out of the Inbox.** Every path is a `.md` note under `Inbox/` at the
  root of the vault; any other is listed in `failed` and left where it is.
  So is a proposal (a note of type `proposal`, wherever it is): it is
  answered through the proposals routes, never filed. `GET /v1/inbox` (MCP
  `atlas_inbox`) reads what waits to be filed, as the Inbox page lists it —
  proposals aside — and writes nothing. It pages (#167) by `limit` and a
  `cursor`, with a `total`: not by `offset`, as `/v1/archive` does, because
  a caller triaging the Inbox files what each page listed before asking for
  the next, and every note after them would move up past an offset. The
  Inbox is newest first, not path order, so its cursor is the last note's
  place in that order — its modified time and its path.
- **The destination is fixed by the note's name and the project's own path.**
  The caller chooses the project, not the place: a note lands in the
  project's folder — beside the project's note, named as it, or the folder it
  is already the note of — under its own file name, numbered if that is
  taken, never over anything. The project must be a note of type `project` or
  `area` that is in use (not in the Inbox, not archived, not in `.atlas` or a
  hidden folder), whose folder is not the Inbox, the Archive or a hidden
  folder (a project at `Archive.md` would file into `Archive/`, archiving
  what it files), and not so deep that a note filed under it would be past
  `VAULT_WALK_DEPTH`; anything else refuses the whole request with `invalid`
  before a note moves.
- **At most 100 paths**, **typing never saved** (`unsaved_in_app`), links
  rewritten and counted, and every unfinished note named in `failed` — as for
  the Archive.

### Clarifying is the same move, with one save before it (#112, 2026-10-12)

`POST /v1/inbox/clarify` (MCP `atlas_clarify_inbox_item`) runs the app's own
`clarifyInboxItem` for **one** note: what was decided — status, who it waits
on, defer, due, contexts — is one write through `setNoteProperties`, the
byte-preserving chokepoint where the task rules hold, and a note in `Inbox/`
given a project is then filed by `processInboxItems`, under every limit
above. So it adds no new kind of write, only an order: everything is judged
first and a refusal (`invalid`) writes nothing; the properties are written
before the move, so a filing that fails leaves a clarified note where it was
and says so in `failed`. Its note, its project and its person must each be a
`.md` note outside `.atlas` and hidden folders; the person must be of type
`person` and in use. A task outside `Inbox/` is linked to its project and
never moved — the caller still chooses no destination. Typing is never saved
(`unsaved_in_app`). Undo stays in the app: it holds the note's text as it
was, which no answer should carry.

Setting a vault's types up for PARA writes into `.atlas/types` and stays in
the app, which offers it; `/v1/types` reads the result, including each
relation's `targets`.

**Narrowed from P30-01's card (2026-10-08).** The card asked that opening a
vault missing the Area type add it. Atlas does that only for a vault that
already files by project — one with a Project type: there the Area and
Resource files it lacks are written on opening, and each one written is a
line in Activity. A vault with no Project type has not taken PARA up, so the
types are only offered, on the Inbox page, beside the offer to add `project`
to the vault's own Task and Meeting types — which is never done without a
yes, since it rewrites files the vault already has. Writing the types into
every vault that opened put a Project, an Area and a Resource into vaults
that never asked for them. Accepting works the change out again from the
type files as they are then, so an edit made while the offer waited is kept.

**Amended 2026-10-14 (#162): Atlas's own built-in types gain what Atlas ships on
them, on opening.** This changes the narrowing above for one set of types, and
no other. A Meeting type written before `tasks` and `decisions` shipped had
every action-item proposal refused at Accept until someone accepted the Inbox's
offer, which a person who never opened the Inbox page never saw. So opening a
vault now adds the properties a type file lacks, once, to Atlas's own built-in
types that are not PARA's: **Meeting, Proposal, Decision, Daily and Block**
(`shippedPropertiesPlan`).

- **Project, Area, Resource and Task are never changed without a yes.** A vault
  shapes these its own way, and PARA's and GTD's keys on them stay the offer
  described above (ADR-0029 for Task).
- **Additive, once, and the person's keys win.** A key the file declares —
  judged from the file's own keys, even one Atlas cannot read — is never
  changed. The keys added are lines put in after the last of the file's
  `properties`, at its indentation; every line the file had stays byte for
  byte, and a result that is not exactly that is not written. Each type found
  with its shipped keys is recorded as
  settled in `.atlas/migrations/type-properties.md`, whether or not anything
  was written, so a key the person removes later stays removed, on either Mac;
  the Inbox offers it back instead.
- **Left alone when it cannot be added to as lines.** A type whose
  `properties` is a list or a sentence, or an inline `{…}` map, and a type two
  files claim (a sync's conflict copy), is not changed and not settled, and
  Activity warns which and why — for two files, to merge them. Accept and the
  Claude step read whichever claiming file comes first, so the Inbox offers
  neither of them anything either.
- **Never silent.** Each type changed is an info line in Activity naming what
  it gained; a type that could not be written is a warning and is tried again
  on the next open. A record that cannot be read — its folder failing to list
  included, which is never taken for "no record" — stops it before anything is
  written. One run at a time per vault: an open while one is under way (React
  StrictMode's second effect) shares it.

## Amendment: tasks follow GTD, and the migration stays in the app (P30-02, 2026-10-08)

ADR-0029 gives tasks eight statuses. What the API does about it:

- **Writes are held to the same rules as the app's**, by the same code: the
  rules live in the application's write chokepoints — `setNoteProperties`, a
  pane's `saveNote`, `createNote` — which the app and every API route that
  changes or makes a note go through. ~~`waiting` without `waiting_on` is
  refused with `invalid` (mapped once, in `failureOf`) and writes nothing;~~
  _(Amended 2026-10-14, #202: `waiting` never needs `waiting_on`.)_ `archive` sets `completed` to the request's day. A rule kept in one place
  cannot drift between the app and the API.
- **Capture starts a task in the Inbox** when the vault's Task type has the
  `inbox` status; a vault still on statuses of its own keeps its template's.
- **The migration has no route.** Moving a vault's tasks to the eight statuses
  rewrites every task, the Task type, and the views and automations that name
  a status. It is previewed, run and undone in the app, from the Inbox, where
  the person sees every task old → new before anything is written; a request
  that rewrote every task at once is the blind bulk write this ADR keeps out.
  Its record lives in `.atlas/migrations`, which the API never writes.
- MCP's `atlas_capture_task` and `atlas_update_properties` describe the eight
  statuses and the two rules, so a model writes them as the app does.

## Proposals: listed, accepted, rejected (P29-02, 2026-10-08)

Proposals are notes of the built-in `proposal` type in `Inbox/Proposals/`
(ADR-0028), answered in the Inbox page's Proposals section. The API follows on the same terms
as every route above, through the page's own use-cases (`listProposals`,
`acceptProposalNote`, `rejectProposalNote`), so no rule is decided twice:

- **Read.** `GET /v1/proposals` lists the open ones with what each would
  write, and names any it cannot read.
- **Accept writes a note in user space, and nothing else of the caller's
  choosing.** What is written is the proposal's own payload, by
  `applyProposal`: a new note of the kind's type, made with the exclusive
  create, never over a note (a note already at its path is a refusal, since
  it may be the very one proposed); or one link added to a relation of an
  existing note, through the byte-preserving frontmatter write, guarded by
  the digest the proposal recorded and the note's modified time. A payload's
  folder, and a link's note, must be user space (`isUserSpaceNote`: not
  `.atlas`, a hidden folder or one the walk never reads), and neither the
  Archive nor the proposals folder; a link's note is found as the vault
  spells it, so the pane asked about typing is the one holding it.
- **Who answered is kept.** Accept and reject stamp `answered_via: api` on
  the proposal (the app's buttons stamp `app`), so the Archive records that
  a proposal was answered from outside the app — by an MCP client James
  asked.
- **The proposal moves, by the Archive's rules.** Accepting or rejecting
  files the proposal in the Archive at its own path, through `archiveNotes`
  — the amendment above holds: user space only, never over anything, the
  destination fixed by the note's path. These are the only routes besides
  `/v1/archive` that move a note, and each moves only the proposal it names,
  only from `Inbox/Proposals/`.
- **Typing is never saved for anyone.** A proposal, or a link proposal's
  note, open in Atlas with unsaved typing is refused (`unsaved_in_app` for
  the proposal; `conflict` with the reason for the note), and nothing moves.
- **Every refusal the vault causes is `conflict`**: decided already, a note
  already there, a note changed since the proposal was made. Two accepts at
  once make one write; the second is a `conflict`.
- **Not routes: Edit and Undo.** Editing a payload is the person changing
  what Claude proposed; a caller that wants something else written has the
  note routes. Undo takes back an accept only if nothing changed what it
  made since, and is offered once on the page that reported it, from what
  the app holds. Making proposals is P29-03's Claude step, inside the app.

MCP: `atlas_proposals` (read-only), `atlas_accept_proposal` and
`atlas_reject_proposal`. Accepting through MCP is James asking his own Claude
to accept for him; the step that _makes_ proposals unattended (P29-03) has no
tools at all (ADR-0028), so it cannot accept its own.

## Amendment: blocks are notes, and a task's schedule is read with a query (P31-01, 2026-10-08)

ADR-0030 makes a timeblock a note of type `block`. What the API does about it:

- **No block routes.** A block is made, read and changed through the notes
  routes, guarded and byte-preserving as every note write is.
- **The schedule is read, never written.** `POST /v1/query` with
  `schedule: true` on a query of tasks adds each task's estimate, scheduled,
  done and over, worked out by the same application code the task's page
  uses. A read the index's row cap cut short is `query_failed`, not a short
  answer.
- **The Block type is the app's to write**, into a vault whose tasks follow
  GTD; the API never writes `.atlas/types`.
- MCP's `atlas_query` takes `schedule`.

## Amendment: a task is scheduled into a new block (P31-02, 2026-10-10)

Planning the day drags a task onto the calendar. What the API does about it:

- **`POST /v1/tasks/schedule`** (MCP `atlas_schedule_task`) makes a block for
  a task, `minutes` from `start`, by the app's own `createBlockForTask`: a new
  note through `createNote`, from the Block template when the vault has one,
  never over a note that is there. It is the only route that writes a block
  of its own making; a block's other changes, adding a task to one included,
  stay with the notes routes, guarded and byte-preserving.
- **The task must be a task**, named by its path; a start that is not exactly
  local wall-clock time to the minute (`2026-10-12T09:00` — no seconds, `Z`
  or offset, which would name another moment than its digits), or a length
  outside 1 to 1440 minutes, is `invalid` before anything is made.
  Without `minutes`, the block is sized as the app sizes a dropped task, from
  the schedule `POST /v1/query` reads.
- **No undo route.** The app's Undo puts a block it made in the Trash; the
  API deletes no note, so a block made through it is deleted in the app, as
  any note is.

## Checklists: progress read, a line promoted (P30-03, 2026-10-08)

- **Progress is read wherever rows are**: a `progress` column of
  `POST /v1/query` and saved-view runs (unless the type declares its own),
  the `progress` field of an Atlas query, and `files.progress` and the
  `checks` table for SQL. It is worked out in TypeScript as the index is
  filled (ADR-0005), so every reader agrees with the bar the app draws.
- **`POST /v1/notes/{path}/promote`** runs the app's own use-case, so the
  task is made by `createNote` and the line rewritten by `saveNote`: byte-
  preserving, refused under unsaved typing, held to the task rules. The line
  is named by its words, and by its place only when two say the same — what a
  model reads in the note, not a count it must keep. MCP:
  `atlas_promote_checklist_line`.
- **The one take-back.** A promotion whose line could not be written (the
  note moved on mid-request) trashes the task that same request made, so
  nothing is left half done. This is not a delete of anything the caller
  could name before the request; "no delete in v1" still holds, and the
  app's Undo of a promotion — which trashes the task — has no route.
- **A retry is safe.** A line that starts with a link to a task note is a
  task already, and promoting it is refused with `exists`: a request sent
  twice makes one task, so MCP marks the tool idempotent. The line is named
  by its words as shown or by its markdown as the note's writer writes it.

## The weekly review is read; its actions are routes that already write (P30-07, 2026-10-08)

`GET /v1/review/weekly` answers the app's Weekly review page: Waiting tasks
untouched for more than 7 days, active projects with no Next Action or In
Progress task, overdue tasks, Someday and Longterm untouched for more than 30
days, and the Inbox's count. It is read from the index on the app's clock, by
the same use-case the page runs, and writes nothing. MCP's
`atlas_weekly_review` is that one call.

- **No route of its own for the quick actions.** The page's Move, Defer and
  Archive are a status or `defer` written through
  `PATCH /v1/notes/{path}/properties` — held to the task rules at
  `setNoteProperties` — and a project put in the Archive through
  `POST /v1/archive`. A second route doing the same writes would be a second
  place for the rules to drift. The one gap, named rather than hidden: the
  page's Archive finishes a task as the done tick does, so a repeating task
  rolls on to its next date, where `PATCH` with `status: archive` ends its
  series (only a board's move into done rolls one on through the API).
- **Nothing it lists is outside what the API already reads**: user space only,
  never `.atlas` or a hidden folder, never what is archived.

## Today is read the same way (#111, 2026-10-12)

`GET /v1/today` answers the app's Today page — overdue, due today, back from
deferral today, in progress, next actions by project, waiting by person, the
Inbox's count and the stalled projects — by the use-case the page runs, on
the app's clock, writing nothing. MCP's `atlas_today` is that one call. As
with the weekly review, the page's tick, Move and Defer get no route of their
own: they are `PATCH /v1/notes/{path}/properties`, held to the task rules
where every write lands. The page's Undo is not offered through the API: it
is a memory of the session's last write, and a caller that wants a change
back can write the old value itself.

## A note exported for Confluence: read, never published (P32-07, 2026-10-10)

`GET /v1/notes/{path}/export?format=confluence` answers a note as markdown
for a Confluence page, `{ export: { path, format, title, markdown, dropped } }`,
so Claude can share it through its own Atlassian connector. MCP's
`atlas_export_note` is that one call.

- **Atlas never publishes.** The route writes nothing, and nothing in Atlas
  talks to Confluence: no credentials, no site, no second network path. The
  connector Claude already has does the write, as the user asked it to.
- **Only user space reaches the page.** The note is named as any note is
  (`isApiNotePath`), and the titles its links show and the blocks it shows in
  place are read only from notes the API can name. A link into `.atlas` or a
  hidden folder is shared as written, and a block shown from there is
  "not found". The frontmatter never reaches the page at all.
- **Nothing is left out silently.** The conversion is the domain's
  (`exportForConfluence`), and every kind of thing it leaves out — property
  keys, where links went, embeds of files, missing blocks, vault images,
  block ids, comments, callout folds — is listed in `dropped`, each as the
  note writes it.
- **One format, asked for by name.** `format` is required, and `confluence`
  is the only value, so another target can be added without changing what an
  existing caller gets.

## A meeting sent from n8n: written once into the Inbox (issue #93, 2026-10-10)

`POST /v1/meetings` takes a meeting as n8n's workflow assembles it — the
provider and its id, the title, the notes email's subject and arrival, the
attendees, the notes and the transcript — and writes it into
`Inbox/Meetings/` as a meeting/v1 file (ADR-0027). ADR-0027 chose a commit
to the sync repository over this call because the app may be closed; the
route is a second way in for a machine where n8n can reach the running app,
not a replacement. It is held to the terms above:

- **One mapper.** The mapping moved from `tools/n8n` into the domain
  (`packages/domain/src/meetings/mapping`). The route runs it, and n8n's Code
  nodes are compiled from the same files (`pnpm n8n:build`), so the start
  rules (#44, #80), speaker turns (#43) and attendee rules cannot drift
  between the two. Its modules import only each other, since a Code node is
  one script; a test holds them to it.
- **Names its vault, writes only what the domain fixes.** The path is the
  mapper's — `Inbox/Meetings/<date> <title>.md`, else the collision path
  naming provider and hash — in the Inbox folder as the vault spells it,
  made when missing. No caller chooses a path, so it cannot reach `.atlas`
  or a hidden folder. A switch of vault mid-request refuses the write, and a
  meeting found held is answered only while its vault is still open.
- **Never over anything, and once.** A note already holding the provider +
  trimmed id, by the import's own rule (`meetingHolding`, P28-04's holders),
  is answered 200 `in-vault` and nothing is written. The index lags writes,
  so a file already at either path is read too: the same meeting there is
  held; another meeting at both paths is `exists`. Creates are exclusive, so
  two sends of one meeting at once write one file. A folder another send made
  between the listing and the create is used, not refused (`ensureFolder`),
  so two different meetings sent at once into a vault without the folder are
  both written.
- **Refused with the reason.** A meeting with no trustworthy start (#80), or
  whose file meeting/v1 would refuse, is `invalid` with the mapper's or the
  validator's words, before anything is written. So is a key the route does
  not read: idempotency would otherwise lock in a meeting written without a
  misspelt field's content. Null is taken as left out, as n8n sends it;
  attendee records reach the mapper as sent, `group` and all.
- **The import still decides.** The route writes no `atlas_import_outcome`.
  The importing Mac stamps the file as any arrival, after the index has
  heard of it, so the route and the import never write one file together.
- **No secret, no content in Activity.** The host's zone (the default for
  reading instants) is the only new thing the router is handed. Activity
  says the route and the file, never what the meeting carried.
- **No MCP tool.** The route takes a provider's raw meeting and email for a
  program; a model recording a meeting writes a note with `atlas_create_note`.

## People: duplicates and merging (#464, 2026-10-20)

`GET /v1/people/duplicates` and `POST /v1/people/merge` run the People page's
own use-cases. A merge moves no file but the merged people's, into the Trash
— a write the app already makes, recoverable — and writes notes' text in user
space and in `.atlas/templates`, each once and byte for byte apart from the merge, against the version
the preview read. On the same terms as a tag rename:

- **It previews unless `confirm: true`.** The preview names every note
  written, the links that move, and the values the kept note keeps over a
  merged one's, and carries a `version`. A confirm carries the version it was
  shown; the merge is worked out afresh and made only while it gives that
  version again — otherwise `conflict`, nothing written (amended in #467: a
  confirm with no version, or another, is not the merge the caller saw).
- **Typing in the app's panes is saved first, and the index brought up to
  the files** — the app's own refresh, handed to the router — before the
  links are looked for (amended in #467: a link typed a moment ago, or written
  by another program and not yet indexed, would otherwise point at a person in
  the Trash). Typing whose save is refused, or an index that cannot catch up,
  is `conflict`, with nothing written. This is the one route that saves
  typing for the person, as the app's own merge does.
- **A note changed since the preview is `conflict`**, with nothing written.
- **A template, saved view or dashboard linking to a merged person is
  rewritten**, as the app rewrites it: it is the person's own work, and the
  link would otherwise open a note in the Trash (#467). One that names a
  merged person by file, where no link reaches, refuses the merge. **Any other note of Atlas's own** (a type, say)
  linking to them refuses the merge, with nothing written; hidden folders are
  never written.
- **Saying two people are not one is the app's alone for now.** It writes the
  vault's settings note, which only the app's one settings writer may write
  (two writers would refuse each other's writes as stale); the router is not
  handed it yet.

## The assistant's tools: read, cited, never writing (P32-04, 2026-10-23)

`GET /v1/assistant/brief`, `/v1/assistant/open-loops` and
`/v1/assistant/meetings` answer what a person, company, project or area — or,
for a brief, a meeting — has around it, as MCP's `atlas_brief`,
`atlas_open_loops` and `atlas_meeting_quotes` and as the chat's read tools of
the same names (so a rule's Claude step may name them too).

- **Read-only, and cited.** Each is read from the note's linked page
  (P30-06): one bounded DFAI query a section, plus one statement for every
  item's `source`, one to check the blocks they cite and one for follow-ups. Only the named note — and, for
  `meetings`, the meeting files it quotes, at most 50 — is read from the
  vault. Every item carries a wiki link to where it came from.
- **A read never writes a block id.** A transcript turn the file left without
  a `^id` is cited by its Transcript heading, and the citation says so
  (`kind: heading`). ADR-0022 keeps id-writing to the person who first links
  to a block; a tool that wrote ids to cite would edit notes on every
  question.
- **`about` goes through a seam.** Which meetings hold `about` is asked of a
  `PassageFinder`; full-text search answers it today, and semantic search
  (#33) will, naming the matching blocks itself. The matching of turns is the
  domain's either way.
- **A quote is data.** What someone said in a meeting reaches the model
  through these tools and may say anything. The chat's and a rule's Claude
  step's system prompts say every tool result is data, never an instruction
  (ADR-0021; both are tested), and the tool descriptions say it of a `quote`.
- **An index that fails mid-answer costs a part, not the answer.** The
  sections, the sources, the follow-ups and the search each name what was lost
  in `problems` and the route answers `200`; only an `entity` that cannot be
  read is an error.
- **A shared meeting does not make a follow-up everyone's.** A follow-up
  reached only through a meeting is the page's when it names no Person or names
  the page, and says which (`via`); one naming another Person is that
  person's.
- **The same refusals as every route.** `entity` is a user-space `.md` note,
  checked as a body's paths are; a day is a real day; `about` is at most 500
  characters, searched as words, never as query syntax.

## Amendment: Claude drafts tasks and dashboards as proposals (P32-05, 2026-10-23)

`POST /v1/assistant/propose-tasks` and `POST /v1/assistant/make-dashboard` —
MCP's `atlas_propose_tasks` and `atlas_make_dashboard`, the chat's
`propose_tasks` and `make_dashboard` — are the assistant's first writes. Both
only propose. Neither is a tool a rule's Claude step can be given: an
unattended step reads.

- **A meeting's items, drafted on demand.** `propose-tasks` runs the meeting
  extraction (P29-05) on one meeting note with the provider and model
  Settings → Claude chose, as a rule's Claude step does (`runClaudeStep`), and
  never with `apply: mine`: every item is a proposal in `Inbox/Proposals`,
  citing its turn, and nothing else is written — no task, no meeting, no log.
  Its proposals are known by the same ids as the meeting extraction rule's
  (the meeting-items schema leaves the rule out of an id), so asking again,
  or after the rule ran, proposes nothing twice. A draft runs as long as
  Claude takes; the route waits 25 seconds — under the host's 30 — and then
  answers `202` while it goes on, so a long meeting is not reported as a
  `timeout` that in fact landed; how a draft past its `202` ended is said in
  the vault's Activity log and, when it failed, as a notice in the window
  (`AppNotices`), since no caller is left to hear it. Right before its first
  write it checks its vault is still open and the meeting still there. One
  meeting is drafted once at a time, per router (`MeetingDrafts`). This is
  the API's first route that spends, so it does not spend twice on the same
  words: each proposal keeps `meeting_digest`, two hashes of which meeting it
  was drafted from (provider and id, else path) with that meeting's body, and
  asked again about the same meeting with its body unchanged — counting only
  proposal notes — the route answers `unchanged` without asking Claude. The
  check before the first write also asks that the meeting at the path is
  still the same meeting, by provider and id. A meeting whose draft proposed
  nothing is asked about again; the MCP tool says that a draft costs.
- **A dashboard or view, checked, then proposed.** `make-dashboard` checks a
  spec with the app's own checkers — the widget editor's (`widgetProblems`,
  whose last word is the dashboard parser) for a dashboard, the New view
  dialog's (`newViewFieldProblems`) for a view — against the vault's types. A
  spec either refuses is `invalid`, with every problem as `{ at, message }`
  in the error's new `problems` field, the checker's words, so a caller can
  fix it and ask again — at most 50, each cut at 200 characters, so a spec
  of long text cannot make the answer large. The checker refuses rather
  than coerces what the editor's draft would read loosely: filters it cannot
  read, an unknown `show` or `icon`, a `span` or `limit` out of range, a
  `title` that is not text, a `highlight` neither text nor a number, a name
  with nothing visible or an invisible character outside an emoji (a format
  character, a joiner not between two emoji, tag characters outside a
  subdivision flag).
  Asked for again, a spec already proposed is not proposed twice, and the
  answer says what became of the first. Before Accept, the Inbox card shows
  each widget as Accept will write it, every SQL statement and DFAI query
  whole: what runs once it is accepted is read first. One that passes becomes a `dashboard` or
  `view` proposal in `Inbox/Proposals` — user space, as every proposal is.
  Nothing a spec says names a path: the folder is its kind's, the file name
  its name, cleaned as a view's is, and a widget's key the editor does not
  know is dropped.
- **Nothing reaches `.atlas` without an Accept in the app.** The proposal's
  Accept on the Inbox page writes the entry into `.atlas/dashboards` or
  `.atlas/views` — the one write into `.atlas` a proposal makes — with the
  exclusive create, numbered past a name already taken, its spec checked
  again against the types as they are then; Undo takes it back as any
  accept's. The API's accept (`POST /v1/proposals/{path}/accept`, MCP's
  `atlas_accept_proposal`) refuses a `dashboard` or `view` proposal with
  `forbidden` and writes nothing (`acceptRefusal`, held by
  `acceptProposalNote` itself, so no route can skip it). This holds however
  the proposal came to be: one written or edited by hand through the note
  routes is still a proposal note in user space, and still accepted only in
  the app. So the rule above stands — the API never writes `.atlas` — and
  an MCP client cannot propose a dashboard and accept it for itself.
