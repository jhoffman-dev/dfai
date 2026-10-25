---
name: proposal
label: Proposal
properties:
  kind:
    kind: select
    options: [task, decision, follow-up, person, link, term, project, dashboard, view]
    required: true
  state:
    kind: select
    options: [open, accepted, rejected]
    required: true
  confidence:
    kind: select
    options: [high, medium, low]
  source:
    kind: text
    label: Cites
  made_by:
    kind: text
    label: Made by
  answered_via:
    kind: select
    label: Answered in
    options: [app, api]
---

# Proposal

Something Claude or an automation suggests, waiting for you to accept, edit or
reject it (ADR-0028, P29-02). Claude never edits a note on its own: what it
produces lands here, in `Inbox/Proposals/`, and the **Inbox** page lists the
open ones in its Proposals section.

Proposal is built in: the Inbox's Proposals section reads notes of it, so it cannot be
deleted. Its properties are yours to change.

## What a proposal holds

- `kind` — task, decision, follow-up, person, link, term, project, dashboard or view.
- `payload` — what Accept writes. Not a property, because no property kind
  holds a record. For every kind but `link`: `title`, and optionally
  `folder`, `properties` and `body`, which make a note of the kind's type
  (a follow-up is a task). For `link`: `note` (a path), `property` (a
  relation of that note's type), `link` (`[[Note]]`) and `digest`, what the
  note held when the proposal was made.
- `source` — the block it came from, as a link: `[[2026-10-01 Standup#^t0003]]`.
  A task, follow-up or decision copies it into its own `source`.
- The meeting is not worked out from `source`: whatever makes a task,
  follow-up or decision proposal from a meeting puts `meeting: "[[…]]"` in
  `payload.properties` itself (P29-03's output schema requires it), so the
  task links its meeting.
- `confidence` — high, medium or low.
- `made_by` — the rule and run that made it.
- `state` — open, then accepted or rejected.
- `answered_via` — where it was answered: `app` (its buttons) or `api` (the
  local API, an MCP client asked by you).

## What happens to it

Accepting writes the payload and archives the proposal with `state: accepted`;
rejecting archives it with `state: rejected`. So `Inbox/Proposals/` holds only
open ones, and the Archive keeps the rest. One the Archive refused stays,
answered, and the Inbox lists it apart so it never just vanishes.
