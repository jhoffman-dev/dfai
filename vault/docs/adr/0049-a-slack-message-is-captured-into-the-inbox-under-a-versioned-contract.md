---
type: adr
id: ADR-0049
title: A Slack message is captured into the Inbox under a versioned contract
status: accepted
date: 2026-10-28
---

# ADR-0049 — A Slack message is captured into the Inbox under a versioned contract

## Context

James asked to "save Slack messages to my notes and / or tasks" (epic #124).
Three ways in are planned, each its own ticket: from inside Slack through
n8n (#104), by pasting a Slack link into DFAI (#105), and by asking Claude
through an `atlas_capture` MCP tool (#106). All three hold the same thing —
one message, maybe its thread, who wrote it, where, and its permalink — and
must land the same way, or a message saved twice by two routes becomes two
notes. Meetings already arrive this way (ADR-0027, `POST /v1/meetings`): a
versioned contract, a pure mapper the app and n8n's Code node both run, and
an API route.

## Decision

**One contract, `capture/v1`, read by a pure domain mapper, and one route,
`POST /v1/captures`.** The mapper (`packages/domain/src/capture/mapping/`)
reads the payload, refuses it with every reason when it is wrong, and
writes the file; the use-case (`receiveCapture`) finds the author's Person
note, checks the vault does not hold the message already, and writes it;
the route reads the request and answers. n8n compiles the same modules into
its Code node (`mapCaptureScript`, `tools/n8n/code-node.ts`), as it does the
meeting mapper, so #104 can map a message without the app, and a test runs
the script under JavaScriptCore as well as Node and requires the same bytes.

**The payload** (JSON) is `contract: 'capture/v1'`, `kind: note | task`, an
optional `title`, `source: { provider: 'slack', channel: { id, name? }, ts,
url, author: { id?, name, email? } }`, `text` (Slack mrkdwn), and optional
`thread` (replies: `ts`, `author`, `text`, `url?`), `attachments` (`name`,
`https://` `url`) and `users` (names for `<@U…>` mentions). A null optional
field is left out; a field the contract does not have is refused. The full
rules and limits are in `vault/docs/api/v1.md`, "Captures". v1 reads only the
`slack` provider; another is refused, not guessed at.

**The key is the channel and the ts: `external_id: <channel>/<ts>`.** Slack's
ts is unique within a channel, and a channel id across a workspace. The
permalink is not the key: Slack writes it with a workspace's or an
Enterprise Grid domain and with query parameters, so one message has many.
The permalink must point at the same channel and ts, or the capture is
refused. The key is written into the note's frontmatter beside
`atlas_import: capture/v1` and `provider`, and a capture is in the vault when
the index finds a note holding all three — wherever it has been filed since,
the Archive included — or when a file in `Inbox/Captures/` whose name ends
in the key's hash holds them (the index lags a write made a moment ago, and
a second sender may title the message otherwise). Then nothing is written,
and the answer names the note that holds it. A capture never updates a note
it made: a message saved again with more replies is still the one note.

**The file is the payload's and the options' alone: no clock, no randomness.**
Its path is `Inbox/Captures/<title> (slack <hash of the key>).md`. The title
is for reading; the hash is what finds the note, so a message sent twice with
two titles — n8n's from its first line, a pasted link's as typed, or the
first line of a message edited in between — is still one note. (The first
build named it `<title>.md` and used the hash only on a clash, so two titles
for one key made two notes while the index lagged; review of PR #615.) The
hash is 64 bits — FNV-1a from two bases, over the key and over it backwards,
16 hex digits — since 32 bits gave two messages 71 seconds apart in one
channel the same name (attack on PR #615). Should two keys still share one,
the second is written at a numbered path, `… (slack <hash> 2).md` and on to
9, never refused for it: a note at the path holding another `external_id` is
another message's.
Times are shown on the zone the request names, else the Mac's, and
`sent_at` is UTC.

The same bytes are written for one message only when the writers agree on
two things besides the payload: **the zone** and **the author's Person
link**. Two Macs on one synced vault in one zone do: they read the same
People. n8n does not, as built: it maps on `America/Los_Angeles` with no
vault to find a Person in, so where the app would write `[[Mara Quill]]`
n8n writes `Mara Quill`, and a Mac in another zone shows other times. Both
writers land on the same path, so the second finds the first and writes
nothing (`in-vault`); only two writers racing before either has synced
would leave a sync conflict copy. #104 should send to the app when it runs,
and commit a file itself only as the fallback.

**One capture of a message at a time, on each Mac.** Two captures of one
message at once — n8n's and a pasted link's, under two titles — would each
find the folder empty. `receiveCapture` holds a lock per key in the app, so
the second waits for the first and then finds its file by the key's name
(second attack on PR #615). Two Macs capturing one message at the same
moment still meet only in that folder check, once a sync has brought one's
file to the other; until then each may write its note, and the sync keeps
both (a conflict copy where the two bytes differ). The lock has no time limit: a write
that never answers holds that message's lock — only that message's — for
the life of the app's process, and a later capture of it waits behind it.

**It lands in the Inbox folder, as a task at `status: inbox` or a plain note.**
The Inbox is where captures wait (P30-01), and its folder is what puts a note
there. The issue asked for a note "tagged inbox"; no tag is written, since a
tag would stay on the note after it was filed and say it still waited.

**An author is linked by email alone.** An author whose address is a Person
note's `email` or `other_emails` is written as `[[that note]]`, in `author` and
in the message's quote, by `matchAttendees`' comparison, so capture and
meeting import never disagree on whose an address is. (PR #604 moves that
comparison to one `emailKey`; capture follows it with no change of its own.)
A Slack display name is too loose to link by, so no one is linked by name; a
link target that `]`, `|`, `#` or `^` would break is written as the name.

**The body.** The message is a quote — who, when, an "Open in Slack" link,
then its words — with its block id on the next line (ADR-0022,
`^m<ts>`); a `## Thread` holds a quote per reply, each with its own id
(`^r<ts>`), so a reply is citable; `## Attachments` lists the files as links,
never downloaded.

**The body is a markdown tree, written by the editor's own serializer.** The
mapper never writes markdown text. It builds an mdast tree — paragraphs,
quotes, code, a heading, a list; text, strong, emphasis, delete, inline
code, links, and the one wiki link it makes itself, a Person's — and a
sender's words are only ever a `text` node's value or a link's label. Slack's
`*bold*`, `_italics_`, `~strike~`, code, code blocks (never with a language,
so no `atlas-query`), `<url|text>` links (only `https://`, `http://` and
`mailto:`; another scheme keeps its label as words), and mentions become
their nodes; a token is a node, never text joined to the words beside it.
The tree is written a block at a time by `writeCaptureMarkdown`
(`packages/adapters/src/markdown/capture-markdown.ts`), which is
`mdast-util-to-markdown` with GFM's extension and the settings, handlers
and escape rules the editor's `renderBlock` writes every block with
(`stringify-settings.ts`, shared by both), plus one escape the editor does
not need: `#` before a word, which the editor writes only for a tag. So the
library escapes `[`, `*`, `_`, a rule, an underline, a list marker, a
table's delimiter row and `^`, and a capture's bytes are what the editor
would write for its tree. The domain has no markdown library, so it is
handed the writer (`CaptureOptions.writeMarkdown`; in the app the markdown
port's `writeTree`; in n8n the same writer bundled into the Code node by
`pnpm n8n:build`, `tools/n8n/capture-markdown.bundle.js`, about 59 kB, which
JavaScriptCore runs to the same bytes as Node).

**Every address a reader could find in the words is a link the mapper made.**
GFM reads addresses twice: its syntax reads them in the source, where an
escape stops it, and its mdast transform reads them in a text node's words
once escapes are read, where nothing does; and the editor may write a
line's words back without their escapes once it is edited. So before the
tree is written, `linkifyPhrasing` joins neighbouring text nodes, as
markdown reads them back, and makes a link of every address either reading
could take — `http(s)://` with any domain, `www.`, and `name@domain.tld`,
after any character and in any case, run on to the next space and cut as
GFM cuts trailing punctuation. A link more than GFM would make is only an
address made a link; one fewer is a sender's words read as one. Its scans
are linear (a test holds their steps to 8 × the words), where GFM's own
patterns retry from every character. A link whose label is its own address
(`[www.x](http://www.x)`) is given its encoded address as a title: the
editor reads a link like that as an address typed bare, writes it back bare,
and GFM then runs it on into the words after it; a titled link it keeps.
Every link's address is percent-encoded where it holds `[`, `]`, `!`, `<`,
`>`, a quote, a parenthesis, a backslash, a space, a character beyond ASCII,
or an `&` that starts an entity. An IPv6 host's brackets are kept, so a browser opens it: one `[` is no
wiki link (third attack on PR #615).

**Bold or italic side by side never runs into an address.** The editor
writes the second of two neighbouring marks with `_` (A21-03), and `_` is a
character of a mail address's name: `**Mara**__Quill__@example.com` was a
mail link to GFM, the bold gone — in a capture and in the editor's own save
(third attack on PR #615). A run of neighbours that would end in a `_` with
an `@` and a dotted domain after it now starts with `_` instead, so it ends
in a `*`. The markers are worked out once per parent, in one pass, where
the old rule asked about every earlier neighbour for each node: cubic, and
recursive, on a message of ten thousand marks. The handler is the editor's
too; every other note it writes is byte for byte what main wrote, held by
`editor-writes.main-parity.test.ts` against a frozen fixture of main's
writes (the round-trip corpus, 3,000 seeded documents, and the repo's
markdown).

**Why hand-written escaping failed, three times** (review and attacks on PR
#615). The first build escaped special characters in the words and broke a
bare address's `:`; GFM's transform reads an address after escapes are
read, so the link ran on over the escapes after it, and an edit wrote them
back raw. The second linked addresses in a message's text only, after a
character that was not a letter; names, labels, an address after `é` or
`_`, and an address split by a token's edge were left to GFM. The third put
every piece of words through one writer; its address pattern still stopped
where GFM's does not (`]`, `[`, a no-break space, a held token), and a mail
address across a mention's edge was never seen whole. Each was a second
reading of markdown beside the library's, and they drifted. The tree leaves
one reading. The acceptance test is the attackers' property test
(`captures-roundtrip.property.test.ts`): hostile payloads in every field,
mapped, every block parsed as the editor holds it and written back, three
times — no link the mapper did not write, no link to anything but an
address, no wiki link, embed, tag, rule, table or HTML, and a fixed point.

Control and direction characters, and half surrogate pairs, are taken out
before anything reads the text. Frontmatter values are single-quoted, a
sender's brackets in them made parentheses. A file name never starts with a
space or holds nothing before its key: a title that leaves nothing once
fitted is `Slack message`.

**Refusals name every reason**, each with its field, quoting at most 40
characters of what was sent, and nothing is written.

## Consequences

- #104 sends `POST /v1/captures`, and can map a message itself with the
  compiled script for its fallback of committing the file; #105 and #106 call
  the same use-case. The MCP tool is #106's.
- A file dropped into `Inbox/Captures/` by a sync already waits in the Inbox,
  being in its folder. Recognising a dropped file as a duplicate of one
  already filed, as the meeting import does, is not built: no writer drops
  one yet (#104 decides whether it needs to).
- An author with no Person note is written by name. Proposing a Person for
  them, as meeting linking does, is a follow-up.
- A second provider is v2's, or a new value of `provider` with its own
  reading of `text`; v1 files keep reading as they are.

## Amendment, 2026-10-28: how #104 sends and falls back

- **n8n sends to `POST /v1/captures` first** and commits the file to
  pkm-space only when DFAI does not take it: no answer, or any status but
  `200`/`201`. The commit is the app's own mapper, compiled into the Code
  node (`mapCaptureScript`), on `America/Los_Angeles` with no Person links.
- **The commit's "is it there?" is the folder listing of `Inbox/Captures/`**:
  a file whose name ends in the key's hash, numbered or not, in any case, is
  taken as the message's, and nothing is written. It does not read the file
  to compare `external_id`s: a 64-bit clash inside one folder is not worth a
  fetch per candidate, and the reply names the path it found, so a wrong
  skip is never silent.
- **A dropped file is still not marked a duplicate of one already filed**
  (Consequences, above). The commit runs only when DFAI is not there, and
  only a message saved again after its note was filed out of the Inbox
  lands twice; the README lists it as a known gap.
- **James is told in Slack by the app's bot**, a DM (`chat.postMessage` to
  his member id): it works in every conversation, the bot a member of none,
  where an ephemeral reply needs the bot in the channel.

## Amendment, 2026-10-28: a pasted link, and one shaping of Slack's answers (#105)

A Slack message link pasted into a note or quick capture is read by the
app through a host module pinned to `https://slack.com` (`slack.rs`), as
Granola is (ADR-0034): a user token kept in the Keychain at
`<vault>:apikey/slack`, never a named secret, sent only to a short list of
read-only Web API methods (`auth.test`, `conversations.replies`,
`chat.getPermalink`, `users.info`) by GET, no redirect followed, and struck
from every answer and failure. The webview learns only whether a token is
kept. What Slack's answers mean — `ok: false` and its code, a 429 and its
`Retry-After` — is the domain's (`slackAnswerFailure`), and so is what the
person is told.

The answers become a capture/v1 payload in the domain, in one copy:
`slackCapturePayload`, `usersToLookUp` and the fitting to the contract's
limits, written for n8n in PR #623, live in
`packages/domain/src/capture/slack/`, beside the mapping folder and
importing only from it. A pasted link shapes its message with them,
`chat.getPermalink`'s link included, and n8n's Code node imports the same
modules, bundled in as the mapper is (PR #631 deleted #104's copies in
`tools/n8n/`), so a fix reaches both senders at once. The payload goes
through `receiveCapture` like `POST /v1/captures`'s: one code path, one
dedupe. A pasted link looks up its reader first, as n8n looks up whoever
asked, so in a thread of more than 100 people both spend the same 100
lookups and name the same people.
