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
for one key made two notes while the index lagged; review of PR #615.)
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

**Slack's formatting is markdown; everything else a sender wrote is words.**
`*bold*`, `_italics_`, `~strike~`, code, code blocks, `<url|text>` links,
user, channel and special mentions become their markdown or their text. Then
every character markdown or DFAI reads as more than itself is escaped — `#`
(headings, tags), `[` `]` (links, wiki links, embeds, checkboxes), `^` (block
ids), `<` `>` (HTML), `|` (tables), backticks and tildes (fences), `*` `_` `~`,
the backslash, and an `&` that starts an entity. A bare address in the
words (`https://…`, `www.…`) is written as an explicit link,
`[address](address)`, cut where GFM would cut it. Escaping its `:` was the
first build's answer, and it was wrong (review of PR #615): GFM still reads
the words as a link, the link runs on over the escapes after it, and once
the paragraph is edited the editor writes them back without the escapes, as
a real wiki link or tag. An explicit link is a link node either way, and is
written back as one. Every link's address is percent-encoded where it holds
`[`, `]`, `!`, `<`, `>`, a quote, a parenthesis or a backslash, since the
index reads a wiki link or an embed even inside an address. A line of `-`, `=` or `+` is kept from being a rule or a
heading's underline. A code block's fence never carries an info string, so a
message cannot run an `atlas-query`. Only `https://`, `http://` and
`mailto:` links are written; another scheme keeps its text. Control and
direction characters, and half surrogate pairs, are taken out before
anything reads the text. Frontmatter values are single-quoted. A seeded
property test holds the mapper to this over hostile text, and the adapters'
integration test reads the files back through the real parser.

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
