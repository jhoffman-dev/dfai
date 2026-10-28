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
the Archive included — or when the file at the capture's own path holds
them (the index lags a write made a moment ago). Then nothing is written,
and the answer names the note that holds it. A capture never updates a note
it made: a message saved again with more replies is still the one note.

**The file is the payload's alone: no clock, no randomness.** Its path is
`Inbox/Captures/<title>.md`, or `<title> (slack <hash of the key>).md` when
another note holds that name; times are shown on the zone the request names,
else the Mac's, and `sent_at` is UTC. So the two Macs, or n8n and the app,
mapping one message write one path with the same bytes: a sync of both
merges cleanly rather than making a conflict copy. The one part of the bytes
that depends on the vault is the author's link, below; two Macs on one synced
vault find the same Person.

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
the backslash, an `&` that starts an entity, and the `:` of a bare
`https://` and the `.` of `www.` (a link read from words runs on over the
escapes after it). A line of `-`, `=` or `+` is kept from being a rule or a
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
