# Meetings into DFAI from n8n

Your n8n workflow already reads "Notes by Gemini" emails and writes each
meeting to the Notion Meeting Notes database. This folder adds a **second
destination** beside Notion: the same meeting, committed as one markdown file
to the vault's sync repository, `jhoffman-dev/pkm-space`, at
`Meetings/<YYYY>/<MM>/<YYYY-MM-DD> <title>.md`, the month's folder for the
meeting's date (ADR-0038). A workflow imported before that still writes
`Inbox/Meetings/<YYYY-MM-DD> <title>.md`, which DFAI still reads; re-import
`meeting-to-atlas.workflow.json` to write by month. DFAI pulls that repository every
minute, so meetings arrive even while the Mac is asleep (ADR-0027). The
Notion path is not touched: the DFAI branch runs beside it, from the
assembled meeting before any Notion step, and nothing in it can stop the run.

| File                                                | What it is                                                                    |
| --------------------------------------------------- | ----------------------------------------------------------------------------- |
| `meeting-to-atlas.workflow.json`                    | The n8n nodes to paste in. No secrets: the credential is referenced by name.  |
| `packages/domain/src/meetings/mapping/`             | The mapper, which the Code nodes and DFAI's `POST /v1/meetings` both run.     |
| `github-file.ts`                                    | Whether a file already at a meeting's path is that meeting (compiled in too). |
| `validate-meeting.mjs`                              | Checks a file with the validator DFAI runs: `pnpm validate:meeting <file.md>` |
| `build-workflow.mjs`, `code-node.ts`, `workflow.ts` | Rebuild the JSON after changing the mapper: `pnpm n8n:build`.                 |
| `granola-webhook.workflow.json`                     | Granola's webhooks into DFAI ("Granola webhooks → DFAI" below).               |
| `github-branch.ts`                                  | The GitHub nodes both workflows end in.                                       |

The file format is the meeting import contract,
`vault/docs/contracts/meeting-import-v1.md`.

**Where these live.** The issue (P28-02, #8) planned the setup doc and the
workflow JSON in `vault/docs/contracts/` and the CLI at
`tools/validate-meeting.mjs`. They were built together here, in `tools/n8n/`,
because the JSON is generated from the mapper's TypeScript and a test holds
the two in step; the contract itself stays in `vault/docs/contracts/`.

## 1. Make a GitHub token that can only write to pkm-space

On github.com: **Settings → Developer settings → Personal access tokens →
Fine-grained tokens → Generate new token**.

- **Token name**: `n8n meetings → pkm-space`.
- **Expiration**: a year (put a reminder in your calendar to renew it).
- **Resource owner**: `jhoffman-dev`.
- **Repository access**: **Only select repositories** → `pkm-space`. Nothing else.
- **Repository permissions**: **Contents → Read and write**. That is the only
  one to set; GitHub adds **Metadata → Read-only** by itself. Leave every other
  permission at "No access".

That is everything the workflow needs: reading a file (to see whether the
meeting is already there) and creating a file are both "Contents".

The token lives **only in n8n's credential store**. Never paste it into the
workflow, a Code node, the vault or this repository.

## 2. Add the credential in n8n

On your work computer's n8n: **Credentials → Add credential → GitHub API**.

- **Name**: `GitHub pkm-space (contents)` — exactly this, so the imported
  nodes find it by name.
- **User**: `jhoffman-dev`. **Access Token**: the token from step 1.
- **GitHub server**: leave `https://api.github.com`.

## 3. Paste the nodes into a copy of your workflow

The nodes fit a workflow shaped like this:

- a **notes email** node: the Gmail trigger, or a step after it that keeps the
  email's subject and arrival time (a Gmail trigger names them `subject` and
  `date`). With a second, manual trigger for tests, use the first step both
  triggers feed, so the field is there whichever one ran;
- an **assembled meeting** node, before any Notion step, whose one item per
  meeting holds `title`, `attendees` (a list of `{ name, email }`),
  `summaryMd` (the notes, with `## Summary`, `## Decisions`, `## Next steps`
  and `## Details` headings), `transcriptMd`, `source` (`gemini`), `sourceId`
  (the email's id) and `category`. Any date it holds is when the notes
  arrived, and is not read;
- the Notion steps after it: the People lookups and creates, a "was it synced
  already?" lookup, then the page create.

Work on an inactive copy, so the live workflow keeps running untouched until
the copy is proven:

1. In n8n, open your Gemini → Notion workflow, **⋯ → Duplicate**, and name the
   copy (say, `Meeting notes → Notion + DFAI (staging)`). It is created
   inactive; leave it so.
2. In the copy, open `meeting-to-atlas.workflow.json`, copy all of it, click
   the canvas and press **Cmd+V**. Twelve nodes appear, starting at
   **Meeting fields for DFAI**.
3. Drag a connection from **the assembled meeting node's output** to
   **Meeting fields for DFAI**, beside the connections that already go to
   the Notion steps. Wire it from there, not from a later node: the People
   lookups, the merge with their ids and the Notion writes all come after,
   so a Notion failure, or a meeting with no people to look up, cannot keep
   DFAI from running. Put the DFAI nodes **above** the Notion branches on
   the canvas: n8n (execution order v1) runs the branches of one output top
   to bottom, so DFAI runs first. The DFAI branch cannot stop the Notion
   one: every failure in it leaves by an error output.
4. Open each of the four GitHub nodes and check that the credential shows
   `GitHub pkm-space (contents)`; pick it from the list if n8n asks. Open
   **Email me: meeting not in DFAI**, pick your Gmail credential, and put
   your own address in **To** (it comes as `you@example.com`).

## 4. Point the fields at your nodes

Open **Meeting fields for DFAI**. Each row is one field the mapper reads; the
right-hand side reads one of your nodes by name, so it works wherever the
branch is wired. The rows name the nodes `Assembled meeting` and
`Notes email` (the email): rename your nodes to those, or change the name in
each row (drag the field in from the input panel).

| Mapper field | Read from                             | Becomes in the file                   |
| ------------ | ------------------------------------- | ------------------------------------- |
| `title`      | assembled meeting `title`             | `title`, and the file name            |
| `stated`     | notes email `subject`                 | `date`, and `start` if it has a time  |
| `arrived`    | notes email `date` (when it came)     | `start` (approximate), see below      |
| `attendees`  | assembled meeting `attendees` (Array) | `attendees` (groups marked)           |
| `sections`   | assembled meeting `summaryMd`         | `## Summary`, `## Notes`, next steps  |
| `transcript` | assembled meeting `transcriptMd`      | `## Transcript`, a paragraph per turn |
| `category`   | assembled meeting `category`          | `kind`                                |
| `source`     | assembled meeting `source`            | `provider`                            |
| `sourceId`   | assembled meeting `sourceId`          | `external_id`                         |

`sections` is split by its headings: `## Summary` becomes the Summary;
`## Details` the Notes, with `## Decisions` under them as `### Decisions`;
`## Next steps` the Provider next steps (`- [Owner] Title: description`). Text
before the first of those headings is Summary, and any other heading stays in
the section it is in.

The mapper reads other fields too, for a workflow shaped differently: add a
row with that name. `summary`, `decisions`, `nextSteps` and `details` give the
four parts separately (one given on its own wins over its part of
`sections`); `date`, `start` and `end` give a meeting's real day and times
(Granola's Notion Date is its real start). Never give a Gemini meeting's
arrival as `date` or `start`: it would be taken as when the meeting began.

`title`, a day (`stated` or `date`), a start time, `source` and `sourceId`
are required. Without a start time (in `start`, `stated` or `date`, or worked
out from `arrived` less a transcript's length), the mapper refuses the
meeting with "start: the meeting has no start time… send `start`, a time in
the subject, or a transcript with its times" and it goes to the failure
email. It never makes a start up. (The Code nodes have no calendar to ask;
the API destination below does, and takes such a meeting's start from its
Google Calendar event.)

**When a Gemini meeting began.** A Gemini meeting's notes arrive about when
it ended, so the day and start come from the email itself:

1. `stated` — the email's subject. The mapper reads the **last** date in it
   (`Oct 6, 2026`, `October 6 2026`, `2026/10/06`, `2026-10-06`; a date in
   the meeting's title comes before it) and a time right after it, if any
   (`10:00`, `2:30 PM`). A zone after the time (`13:00 EDT`, `UTC+1`,
   `-04:00`) is converted to `timeZone`'s clock, which may move the day; a
   zone it does not know (`IST` means several), or no `timeZone`, keeps the
   time as written and marks it `start_approximate: true`. Gemini's doc
   title, `Title - 2026/10/06 10:00 PDT - Notes by Gemini`, works too. When
   `stated` is given, `date` is not read at all. Words with no date in them
   are refused.
2. `arrived` — when the email arrived (an instant). When nothing gives a
   start time, the start is the `end` sent, else the arrival, less the
   transcript's length —
   Gemini's "Transcription ended after 00:51:49" line, else its last
   `### hh:mm:ss` section stamp (a little short) — and the file says
   `start_approximate: true`. With no length to take off (no transcript, or
   one with no stamps and no end mark), the arrival is **never** taken as the
   start: it is about when the meeting ended, so the meeting is refused.

The order is: `start`, then the time in `stated`, then the time in `date`,
then (Granola) the first stamped turn, then — only when DFAI maps it, through
the API destination's `POST /v1/meetings` — the meeting's Google Calendar
event, then `end` (else `arrived`) less the transcript. (A Granola note always carries a
start; one without is refused before it is mapped, so the Granola pull never
asks the calendar.)

`attendees` is an **Array** row: the mapper reads `{ name, email }` records.
It reads `Name — email` lines too; for those, make the row a **String**. A
name that is itself an address counts as no name: the attendee is named by
the address's local part, and a real name given for that address wins.

**Transcript title lines.** Above the first `### hh:mm:ss` stamp or turn, a
transcript doc's title is dropped: `## Transcript`, `# Transcript`,
`Weekly sync - Transcript`, `## Q4: planning – Transcript`. Below it, or in a
code fence, the same words are kept as someone's.

**Dates and instants.** Open **Map meeting to DFAI file**; at the bottom is
`const OPTIONS = { timeZone: 'America/Los_Angeles', groupAddresses: [] };`.
The mapper reads two kinds of value differently:

- **A date or a time with no offset** — `2026-10-06`, `10:00`, `2:30 PM`,
  `2026-10-06T10:00` — is a local day or clock time, kept exactly as written.
  `timeZone` plays no part.
- **An instant** — a date-time ending in `Z` or an offset (`-07:00`) — is a
  moment, and is shown on the clock of `timeZone`. The Notion Meeting Notes
  rows are instants: a Granola meeting at 17:02 PDT is stored as `00:02Z`
  the next day, and is written `date: 2026-10-06`, `start: 17:02`.

Change `timeZone` if you move. Set it to `null` only if no value you send is
an instant: with `null`, an instant is refused (it would otherwise land on
the wrong day) rather than guessed at.

**Group addresses.** An attendee is written `group: true` (and never becomes
a Person) when the record says `group: true`, when its address is in
`groupAddresses`, or when its address's local part is a group word — team,
group, all, everyone, list, staff, crew, squad, dept — alone or joined by
`-` or `_` (`staff@…`, `platform-team@…`, `all_hands@…`). A display name is
never read (`Staff Sergeant Rivera` is a person), nor is a dotted
`first.last@` address (`dana.list@…`). Add any other list address to
`groupAddresses`, e.g. `['leads@example.com']`.

**Your own addresses (Granola).** A Code node that maps a Granola note
(`mapGranolaNote($json, OPTIONS)`) also takes `selfEmails`: a note owned by
one of them has its `me` turns written `You`, any other as the owner's name.
They must be the same addresses as the vault's `selfEmails` — DFAI →
Settings → Profile → **Your emails**, or `granola_self_emails` while that is
empty — written as that field shows them: lower case, in its order.
`OPTIONS = { timeZone: 'America/Los_Angeles', selfEmails: ['you@example.com'],
groupAddresses: [] }`. When you change them, change both places: the app and
n8n write the same meeting into the same bytes only while they agree, and
otherwise one of the two becomes a sync conflict copy. Nothing checks this
for you: the workflow lives in your n8n, and its addresses never go into this
repository.

**Who spoke.** Gemini writes one `Speaker Name: words` line per turn, and its
speakers are often not on the attendee list (a shared room, a group invite),
so in a Gemini transcript **every** `Label: words` line is a turn by that
speaker — except a note label, which continues the turn before: `Note`,
`Notes`, `NB`, `PS`, `FYI`, `Re`, `TODO`/`To do`, `Action item(s)`,
`Next step(s)`, `Decision(s)`, `Question(s)`, `Answer(s)`, `Agenda`,
`Summary`, `Update`, `Reminder`, `Link`, `URL`, `Email`, `Phone`, `Subject`,
`Date`, `Time` (any case). A wrapped line whose words open with another
`Something:` (`Phase two: the rollout`) is read as a speaker; that is the
price of never losing a real one.

In a Granola transcript (every turn stamped `**[14:14:22] Name:**`), an
unstamped `Label: words` line starts a turn only when the label is an
attendee's name, a speaker already heard, `You`/`Remote Speaker`/`Speaker 2`,
the first line of a section, has no words after it, or the meeting has no
attendees to check against; otherwise it continues the turn before.

**When DFAI cannot take a meeting.** Every failure in the DFAI branch — a
meeting the mapper refuses (no start time, say), an existing file it cannot
read, both of a meeting's paths taken by other meetings, a commit GitHub
rejects (an expired token) — leaves by that node's error output to **DFAI
commit failed**, and the run goes on to the Notion steps, which the DFAI
branch never touches. **Email me: meeting not in DFAI** then sends you
"This meeting did not reach DFAI: <the error>", with the
meeting's title and Source ID and the execution number to open in n8n. It
says nothing of Notion: DFAI runs first, so Notion may not have the meeting
yet. If that email cannot be sent either, nothing stops: the execution still
shows the error. To be told another way (Slack, say), swap that node for one
that posts there, reading the same expressions.

## 5. Dry run, then swap

**This dry run is the real test of the Code nodes.** The tests run the
mapper under Node; n8n's Code node sandbox is close but not the same. The
mapper uses `Buffer` (which n8n documents) to read GitHub's files, and falls
back to `atob`; it uses `Intl.Segmenter` and the time zone database where
present. A sandbox without them shows up here, not in the tests.

In the inactive copy:

1. Select **Commit meeting file** and **Commit meeting file (other path)** and
   press **D** to deactivate them. (A deactivated n8n node passes its input
   on rather than stopping the flow, so deactivate the two commits — they are
   last — not the lookups.) The lookups still run; they only read.
2. Deactivate every node that writes to Notion, so the test cannot touch it:
   the People create, the Meeting page create, and the transcript appends
   after it (and any Code node between them that reads an append's output).
3. Run the copy on one recent email: your manual test trigger, or pin a past
   execution's trigger data and press **Test workflow**.
4. Open **Map meeting to DFAI file**'s output. Check `path`, `commitMessage`
   and `content`: the date and start are right (fix `timeZone` if not; a
   start worked out from the arrival says `start_approximate: true`). A
   meeting with no transcript and no time in its subject goes to **DFAI
   commit failed** instead, with "start: the meeting has no start time"; that
   is by design, not a fault. Check the
   attendees are split, and the transcript has one
   `**Speaker** [~00:09:44] … ^t0001` paragraph per turn. Otherwise **DFAI
   commit failed** should receive nothing.
5. Optional, on the Mac: copy `content` into a file and run
   `pnpm validate:meeting that-file.md` in the DFAI repo. `ok` means DFAI
   will accept it.
6. Reactivate both commit nodes (leave the Notion writes off), run once more,
   and look in `pkm-space` on GitHub for `Meetings/<YYYY>/<MM>/<date> <title>.md`
   and a commit `Meeting: <title> (gemini)`. Within a minute of the Mac
   being awake, it is in DFAI's Inbox.
7. Reactivate the Notion writes. Then, in one sitting, **activate the copy and
   deactivate the original**, so each email is handled by exactly one of
   them. Both poll on the same schedule, so an email that arrives while both
   are active can reach Notion twice (both runs pass the "already synced"
   lookup together); DFAI writes it once either way. To go back, do the
   reverse: activate the original, deactivate the copy.

## How the workflow avoids writing a meeting twice

The path is deterministic: the same meeting always maps to the same
`Meetings/<YYYY>/<MM>/<date> <title>.md`.

1. **Is the path taken?** (GitHub → File → Get) looks the path up.
   - Not found → its error output goes to **Commit meeting file**, which
     creates it.
2. Found → **Same meeting?** decodes the file and compares its `provider` and
   `external_id` with this meeting's (ADR-0027's duplicate rule).
   - Same → **Skip: already in the vault**. Re-running the flow, or the same
     email arriving twice, writes nothing.
   - Different (two meetings with one title on one day, like two `1:1`s) →
     **Is the other path taken?** looks up
     `Meetings/<YYYY>/<MM>/<date> <title> (<provider> <hash>).md`, where the hash
     is 8 hex digits of the provider and Source ID (an id may hold characters
     a file name cannot, or be too long; the name stays within 255 bytes and
     keeps the date). Not found → **Commit meeting file (other path)** creates
     it. Found → **Same meeting at the other path?** checks it the same way:
     this meeting → skip; another → **DFAI commit failed** (it never writes
     a third name).
   - GitHub sends no content for a file over 1 MB, so it cannot be told apart
     → **DFAI commit failed**, rather than a guess that would write the
     meeting twice.

Commits go to `pkm-space`'s default branch. A commit that fails (an expired
token, no permission) goes to **DFAI commit failed**; it is never taken for
"already there".

**Case.** GitHub paths are case-sensitive; the Mac's disk is not. Two
meetings whose titles differ only in case on one day (`Weekly Sync`,
`weekly sync`) are two paths to GitHub but one file name on the Mac, and the
pull would clash. The lookup cannot compare without case (it fetches one
exact path), so this stays a known gap: keep a recurring meeting's title
stable.

One case n8n cannot see: once DFAI has moved or renamed the file (after
P28-04), a re-run would write the meeting to `Inbox/Meetings` again. DFAI
catches that: a second file with the same `provider` + `external_id` is marked
`atlas_duplicate_of` and archived (reversibly).

## What DFAI does when the file arrives (after P28-04)

- The vault's next pull (within a minute of the Mac being awake) brings the
  file into `Inbox/Meetings/`. The Mac that runs the vault's automations
  imports it; another Mac leaves it for that one. Anything left — DFAI
  closed, the other Mac asleep — is settled when the importing Mac next
  opens the vault.
- DFAI checks it against the contract and writes one line into it,
  `atlas_import_outcome:`, right after the `atlas_import: meeting/v1` line
  the mapping writes, saying how it settled it. Nothing else in the file
  changes.
- `imported`: a valid meeting, shown in the **Inbox**.
- `error`: a file that breaks the contract, never deleted or silently fixed.
  It also gets `atlas_import_error:` naming the problem, and is listed in
  the Inbox.
- `duplicate`: a second copy of a meeting already in the vault, archived and
  marked there `atlas_duplicate_of: [[<the original's path>]]`;
  un-archiving restores it. A
  meeting already imported is always the one kept. Otherwise the one at
  `<date> <title>.md` is kept over the one at
  `<date> <title> (<provider> <hash>).md`.
- Each outcome is one entry in Activity.
- **Fixing a file that failed.** Fix it in place and save: DFAI checks it
  again, takes the error out and stamps it `imported`. To send it again from
  n8n instead (after fixing the mapping), delete the broken file first.
  **Same meeting?** skips a path that already holds this provider and Source
  ID, broken or not, so a re-send over it writes nothing.

## API destination: send the meeting to the running app

Instead of committing a file to `pkm-space`, n8n can send the meeting to
DFAI's local API, `POST /v1/meetings` (#93). DFAI runs this folder's
mapper itself (it lives in `packages/domain/src/meetings/mapping`), so the
file it writes into `Inbox/Meetings/` is the one the commit would make, at
the same path, and the import stamps it as any arrival. Sending the same
meeting again writes nothing. The route is described in
`vault/docs/api/v1.md` (Meetings).

It needs **DFAI open, with the API on** (Settings → Connections), on the
Mac n8n's Docker runs on. While DFAI is closed the request fails and the
failure email says so; re-run that execution once DFAI is open. The commit
does not have that limit, so keep it where the Mac may be asleep.

**The token.** Settings → Connections shows the port and the token, which
are also in `~/Library/Application Support/<bundle id>/api.json`. In n8n:
**Credentials → Add credential → Bearer Auth**, named `DFAI local API`,
with the token as **Bearer Token**. It lives only in n8n's credential store,
never in the workflow or this repository. Rotating the token in Settings, or
DFAI moving to another port (it does when its port was taken at launch),
means changing the credential, or the URL and `Host` header below.

**The node.** Add an **HTTP Request** node, say `Send meeting to DFAI`, and
wire it from `Assembled meeting`, beside the Notion branches and above them,
as for the commit (section 3). `<port>` is the port from Settings.

| Setting                          | Value                                                       |
| -------------------------------- | ----------------------------------------------------------- |
| Method                           | `POST`                                                      |
| URL                              | `http://host.docker.internal:<port>/v1/meetings`            |
| Authentication                   | Generic Credential Type → Bearer Auth → `DFAI local API`    |
| Send Headers → Header Parameters | Name `Host`, Value `127.0.0.1:<port>`                       |
| Send Body                        | on; Body Content Type **JSON**; Specify Body **Using JSON** |
| JSON                             | the expression below                                        |
| Settings → Retry On Fail         | on; Max Tries `3`; Wait Between Tries (ms) `5000`           |
| Settings → On Error              | **Continue (using error output)**                           |
| Error output →                   | `Email me: meeting not in DFAI`                             |

```
={{ {
  provider: $('Assembled meeting').item.json.source,
  sourceId: $('Assembled meeting').item.json.sourceId,
  title: $('Assembled meeting').item.json.title,
  subject: $('Notes email').item.json.subject,
  arrived: $('Notes email').item.json.date,
  attendees: $('Assembled meeting').item.json.attendees,
  summaryMd: $('Assembled meeting').item.json.summaryMd,
  transcriptMd: $('Assembled meeting').item.json.transcriptMd,
  category: $('Assembled meeting').item.json.category
} }}
```

Why each part:

- **`host.docker.internal` and the `Host` header.** Inside the container,
  `127.0.0.1` is the container itself; `host.docker.internal` is the Mac.
  DFAI refuses any `Host` but `127.0.0.1:<port>` or `localhost:<port>`, the
  guard against web pages reaching the API, so the node sends that `Host`
  itself.
- **`timeZone`** is left out: DFAI reads `arrived` on the Mac's own clock.
  Add `timeZone: 'America/Los_Angeles'` to the body to pin it.
- **Every field is a string, null or left out.** Null is taken as left out
  (n8n sends it for a field with no value), but `provider`, `sourceId` and
  `title` must be there. A field of another kind (a number, say) is refused
  `invalid`, naming it.
- **Only these fields.** A key DFAI does not read — a misspelt
  `transcriptMD` — is refused `invalid`, naming it, rather than ignored: the
  meeting would be written without that content, and every send after it
  answered "already in the vault". Add a field to the body only once DFAI
  reads it.
- **Groups, as in the commit.** Attendee records go to the mapper as they
  are, so one with `group: true` is a group, and the body may carry
  `groupAddresses: ['leads@example.com']`, as `OPTIONS` does in **Map
  meeting to DFAI file**.
- **Retry on fail** covers DFAI starting up, a sleeping Mac waking, or a
  timeout after the file was written: a retry of a meeting already written is
  answered "already in the vault" and writes nothing.
- **A day but no time** (`Oct 24, 2026`) and no transcript: DFAI takes the
  start and end from Google Calendar (#582) when meetings sync is on — the
  one event on that day with the meeting's title (case, spacing and
  invisible marks aside) that ended at or before `arrived`, at most 3 hours
  before, on the clock the event notes are written on (this Mac's), whatever
  `timeZone` says. With no day in the subject, the arrival's day and the
  day before are both looked at. Two such events, or none, and it is
  refused with what to add. When the workflow knows the start some other
  way, send it as `start` (and `end`), `HH:MM` on the Mac's clock; it is
  read before anything else. An `end` with no date that is earlier on the
  clock than the start (`23:30` to `00:15`) is the next day's, written as
  sent, when that keeps the meeting to 12 hours; longer (`10:00` to `09:00`)
  it is refused `invalid`, as is a dated `end` before the start. A start
  DFAI works out is never checked against the end: it is the end less the
  transcript's length.
- **The error output** sends whatever is left after the retries — a meeting
  with no start time (`invalid`, as in the commit's mapper), both paths held
  by other meetings (`exists`), no vault open (`no_vault`), DFAI closed — to
  the failure email, and the run goes on to the Notion steps.

DFAI answers `201` with `{ "meeting": { "path": …, "outcome": "written" } }`
or `200` with `"outcome": "in-vault"` and the path of the note holding it;
both are success, and nothing follows the node.

## Bringing in the meetings already in Notion (once)

The workflow only sends meetings from now on. The ones already in the Notion
Meeting Notes database come in once, through the same mapper, with
`tools/import-notion-meetings.mjs` (P28-07). It reads a Notion export, maps
each row as the workflow would, checks each file with the validator DFAI
runs, and writes it into a vault. It never writes into your vault unless you
give it that vault's path.
To bring in the rest of the workspace as well (tasks, notes, people, PARA,
teams and daily notes), use the workspace import, which runs this one for
the Meeting Notes: `tools/notion-import/README.md`.

1. **Export.** In Notion, open the Meeting Notes database, then **••• →
   Export → Markdown & CSV**, with **Include subpages** on (the pages hold
   the notes and transcripts). Unzip it into a folder of its own, and any
   zip inside it. Notion
   writes two CSVs, `Meeting Notes <id>.csv` and `Meeting Notes <id>_all.csv`:
   use the `_all` one, which has every column. The pages are the `.md`
   files in the folder beside it. Before exporting, set the Date property's
   format to **Full date** (`October 6, 2026`): `10/06/2026` could be either
   day, so a row written that way is refused, never guessed at.
2. **Run it on a copy of the vault first.**

   ```sh
   cp -R ~/"DFAI Vault" /tmp/atlas-vault-copy
   pnpm import:notion-meetings --csv ~/Downloads/<export>/"Meeting Notes <id>_all.csv" \
     --vault /tmp/atlas-vault-copy
   ```

   Use absolute paths: pnpm runs the script from the repository's folder.
   Do not open the copy in DFAI: it carries the vault's sync settings and
   would sync into `pkm-space`. Read the files in it instead, and
   `pnpm validate:meeting /tmp/atlas-vault-copy/Inbox/Meetings/*.md` if you
   like (the import has already checked each one).

3. **Read the report.** One line per row, then the totals:

   | Line       | Means                                                                                                 |
   | ---------- | ----------------------------------------------------------------------------------------------------- |
   | `wrote`    | The meeting's file, at the path the workflow would use (two `1:1`s on one day: the second's names it) |
   | `in vault` | The vault already holds the meeting, by DFAI's own rule, wherever it is filed; nothing written        |
   | `no id`    | A row with no Source ID: listed, never given one, so not imported                                     |
   | `left out` | A provider you did not name in `--providers`                                                          |
   | `held`     | A Gemini row, waiting for `--gemini-dates` (step 4)                                                   |
   | `refused`  | Why not: no start time, no page for the row, two pages with one Source ID, a file DFAI would refuse   |

   It exits 0 when every row with a Source ID you asked for is in the vault,
   1 when one was held or refused, 2 when it could not run (no such vault, a
   hidden folder, not the Meeting Notes CSV, a file that is not UTF-8). Fix a
   refused row in Notion, export again and run again: the rows already
   brought in are `in vault`, and only the rest are written.

4. **Gemini's rows, and the times.** The Date cell is read the way Notion
   wrote it. A time with no zone, or with a zone other than UTC, is kept as
   written; a UTC time (`(UTC)`, or a date-time ending in `Z`) is an
   instant, shown on the clock of `--time-zone` (default
   `America/Los_Angeles`, as the workflow's). That is right for Granola.

   It is not right for Gemini (issue #44): the Date the workflow wrote for a
   Gemini meeting is when its notes **arrived**, near the meeting's end, and
   it is local time with a `Z` on it. Read as an instant, a Gemini meeting
   would land about your UTC offset early (7 or 8 hours), give or take the
   meeting's length, and some on the day before. So Gemini's rows are
   `held` until you choose how to read them:

   ```sh
   pnpm import:notion-meetings --csv … --vault /tmp/atlas-vault-copy --gemini-dates arrival-local
   ```

   `arrival-local` reads the written time as your local clock time (the
   `Z` ignored) and starts the meeting the transcript's length before it:
   the transcript's last time stamp, so a little after the real start. With
   no stamps in the transcript, the start is when the notes arrived. Each
   such meeting's Notes open with a line saying its start is approximate.
   `--providers granola` brings in Granola's alone, if you would rather wait
   for the fix in the workflow.

   Then compare a few meetings' `date` and `start` with your calendar, from
   each provider. A Gemini meeting should start a few minutes after it
   really did. If they are all about your UTC offset early or late instead,
   the export showed Notion's time on another clock than the one the
   workflow wrote: stop there, and do not run it for real.

5. **Run it for real**, naming the vault, with the options you settled on:

   ```sh
   pnpm import:notion-meetings --csv ~/Downloads/<export>/"Meeting Notes <id>_all.csv" \
     --vault ~/"DFAI Vault" --gemini-dates arrival-local
   ```

   The files land in `Inbox/Meetings/`, and DFAI takes each in as it does a
   meeting from n8n (below): checked, stamped, listed in the Inbox. Running it
   again writes nothing new. Each file is written whole under a hidden name
   and then given its name, so a run that stops partway leaves no part of a
   meeting behind.

| Option                    | Default               | What it does                                                                                 |
| ------------------------- | --------------------- | -------------------------------------------------------------------------------------------- |
| `--csv <file>`            | (required)            | The export's `_all.csv`; its pages are the `.md` files in its pages folder beside it, below  |
| `--vault <folder>`        | (required)            | The vault to write into. It must exist                                                       |
| `--folder <path>`         | `Inbox/Meetings`      | Where in the vault the files go. Not hidden, and not linked out of the vault                 |
| `--time-zone <zone>`      | `America/Los_Angeles` | The clock UTC times are read on; `none` refuses a UTC time rather than read it as local time |
| `--group-address <email>` | none                  | An address to mark as a group (repeat it), as the workflow's `groupAddresses`                |
| `--providers <list>`      | every provider        | Only these providers' rows, comma-separated: `--providers granola`                           |
| `--gemini-dates <how>`    | none: Gemini held     | `arrival-local`: Gemini's Date is when its notes arrived, in local time (issue #44)          |
| `--date-order <order>`    | none: refused         | How a Date written `10/06/2026` is read: `mdy` (month first) or `dmy` (day first)            |

**Which folder.** In `Inbox/Meetings/`, DFAI imports each file on arrival,
and the Inbox lists every one until you file it: a whole history at once.
With `--folder Meetings/From Notion` (any folder outside `Inbox/Meetings/`)
they are filed from the start: the importer has already checked them, DFAI
does not stamp or list them, and if n8n later sends one of them again, that
copy is archived as a duplicate of the filed one.

**Already in the vault** means what it means to DFAI's import (P28-04): a
note stamped `imported` that names the meeting, or an unstamped one that
follows the contract as it. A copy stamped `duplicate` or `error`, or a sync
conflict's copy, does not count, and the meeting is written beside it.

**Not imported:** a row's Attendees relation (the page's Attendees section is
read instead), and its other properties. A page's sections the workflow did
not write, such as a summary you added by hand, go into Notes under their own
heading, so nothing in the page is dropped.

## Granola webhooks → DFAI

A second workflow, `granola-webhook.workflow.json`, brings a Granola meeting
into the vault the moment Granola writes its summary, while every Mac is
asleep (ADR-0034, P28-14). Granola sends `note.generated` to n8n; n8n checks
the signature, fetches the note, maps it with the app's own mapper and commits
it through the same GitHub nodes as the Gemini workflow. The app's own
Granola pull stays the safety net: anything this misses, the pull catches.

```
Granola webhook → Verify Granola signature → Fetch Granola note → (200) Answer 200 → Map → GitHub branch
                         └ refused → Answer 401          ├ 404 → Answer 503 (Granola retries)
                                                          └ anything else, or no answer → Answer 200 → email
```

| Granola or GitHub says…                           | n8n answers Granola   | Then                                      |
| ------------------------------------------------- | --------------------- | ----------------------------------------- |
| A delivery not signed with the secret, or stale   | `401`                 | Nothing (Granola does not retry a 4xx).   |
| The note (`200`)                                  | `200`, before the map | Map, commit; a failure is emailed.        |
| `404`: the note is still processing               | `503`                 | Granola retries with backoff.             |
| Any other status (`401` key, `413`, `429`, `5xx`) | `200`                 | Emailed; the pull catches the meeting.    |
| No answer in 10 s                                 | `200`                 | Emailed; the pull catches the meeting.    |
| A refused note, or GitHub fails                   | `200` (already)       | Emailed: "Email me: meeting not in DFAI". |

A `200` for a failure is on purpose: Granola retries for four days and then
**disables the endpoint without replaying what it missed**, so no answer may
spend that budget on a failure the pull will catch anyway. The `404 → 503`
case is the one retry worth spending. (ADR-0034 had every answer after the
signature be a `200`; the issue's acceptance asks for the `503`, which this
follows. A note deleted while still processing would be retried until
Granola gives up — rare, and the cost is the endpoint, so watch the emails.)

### What only you can do, in n8n and Granola

1. **Granola API credential.** In Granola's desktop app, **Settings →
   Connectors**, make a personal API key (`grn_…`). In n8n: **Credentials →
   Add credential → Header Auth**, **Name** `Granola API` exactly; header
   **Name** `Authorization`, **Value** `Bearer grn_…`. The key lives only
   there and in each Mac's Keychain (rotate it in all of them).
2. **Import** `granola-webhook.workflow.json` as a new workflow (**Workflows →
   Import from file**). Point **Email me: meeting not in DFAI** at your
   address (`NOTIFY_TO` is a placeholder) and its Gmail credential; the
   GitHub nodes use `GitHub pkm-space (contents)` from step 2 above.
3. **Map node OPTIONS.** In **Map meeting to DFAI file**, set `OPTIONS` to
   the vault's settings **byte for byte**: `timeZone` = `granola_time_zone`
   (default `America/Los_Angeles`), `selfEmails` = your own addresses
   (`selfEmails`), `groupAddresses` = `granola_group_addresses`. If they differ
   from the app's, n8n and the app write the same meeting differently and you
   get a sync conflict copy.
4. **Register the webhook.** In Granola: **Settings → Connectors →
   Webhooks**, add the workflow's **production** URL,
   `https://<your n8n>/webhook/granola-to-dfai` (it must be public HTTPS),
   with the events **`note.generated`** and **`note.access_granted`** only
   (never `note.edited`: an imported meeting is not rewritten).
5. **The secret.** Granola shows the endpoint's signing secret (`whsec_…`).
   Open **Verify Granola signature** and replace
   `whsec_PASTE_THE_SECRET_FROM_GRANOLA_HERE` with it. Until you do, the node
   refuses every delivery with a `401`. The secret is in the node's code
   because an n8n Code node cannot read a credential; keep your copy of it
   under the name `Granola webhook secret` in your password manager, never in
   this repository, and do not export the workflow with it in. Re-paste it
   whenever you re-import a rebuilt JSON.
6. **Activate** the workflow, then send Granola's **test event** from the
   webhook's page. A test event names no real note: expect the run to pass
   **Verify Granola signature** and get a `404` or `401` from the fetch (an
   email, or a `503`) — what matters is that it was not answered `401` by the
   verify node. A real meeting then arrives at `Meetings/<YYYY>/<MM>/`.
7. **In DFAI**, set `granola_webhook: true` in the vault's settings, so the
   pull warns when a note it finds should have come by webhook long since (a
   sign Granola disabled the endpoint).

### What to confirm in the n8n UI (the spike)

The ticket asked whether an n8n Cloud Code node can `require('crypto')`. It
no longer matters: the signature check is HMAC-SHA256 in plain JavaScript
(`sha256.ts`, `standard-webhook.ts`), tested against Node's crypto and the
Standard Webhooks spec's own vector, and run under JavaScriptCore to prove it
needs no `crypto`, `Buffer` or `TextEncoder`. What the tests here cannot
reach, and you must see work on the first run:

- **The raw body.** The Webhook node's **Raw Body** option is on, and the
  verify node reads the bytes with
  `await this.helpers.getBinaryDataBuffer(0, "data")` (n8n's documented
  Code-node helper, in "Run Once for All Items" mode). If n8n refuses it, the
  verify node fails and every delivery is answered `401`: the run's error
  says why.
- **Where the note id is.** Granola documents that the payload carries a
  `note_id`, not where; the check reads it at the top or under `data`. A test
  event that fails with `body: no note_id` means it is elsewhere: tell the
  next agent the payload's shape.
- **The status branches.** The fetch is set to "Include Response Headers and
  Status" and "Never Error", so its output has `statusCode`; the If nodes read
  `$json.statusCode`.

### Files

`granola-webhook.workflow.ts` builds the workflow, `granola-code-node.ts` its
two Code nodes' scripts, `granola-webhook.ts` and `standard-webhook.ts` the
check, `sha256.ts` the hash. `github-branch.ts` is the GitHub half both
workflows share, so a change to it changes both JSON files.

## Changing the mapper

The mapper is `packages/domain/src/meetings/mapping/` (since #93, so the app's
`POST /v1/meetings` maps by the same rules); `github-file.ts` here holds the
workflow's own checks. Edit them, run `pnpm n8n:build`, then in n8n replace the
three Code nodes' code (**Map meeting to DFAI file**, **Same meeting?**,
**Same meeting at the other path?**) with the new `jsCode` from the JSON — or
delete the twelve nodes and paste the file again. A test fails while the JSON
is out of date with the mapper. The Granola workflow's **Map meeting to DFAI
file**, **Same meeting?** and **Same meeting at the other path?** nodes carry
the same compiled mapper: replace their code too, keeping your `OPTIONS`, and
re-paste the secret into **Verify Granola signature** if you re-import it.

The node names the fields are read from are `EXAMPLE_SOURCES` in
`workflow.ts`; `meetingWorkflow(scripts, sources)` builds the same nodes for
other names. The notification's address is `NOTIFY_TO`, a placeholder.
