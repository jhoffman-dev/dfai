---
type: adr
id: ADR-0003
title: Untouched blocks keep their original bytes
status: accepted
date: 2026-09-20
---

# ADR-0003 — Untouched blocks keep their original bytes

## Context

A WYSIWYG editor over markdown normally reformats the whole file on save: bullets
become one character, emphasis markers change, hard-wrapped paragraphs get reflowed.
For a vault under version control and shared with Obsidian, that is unacceptable —
every save would produce a diff touching everything, and the real change would be
invisible inside it.

Round-tripping markdown perfectly in general is not possible: many different source
texts parse to the same tree.

## Decision

Do not round-trip the document. Round-trip **each top-level block**, and splice.

On open, the body is parsed into blocks, each remembering its exact source text, its
offsets, and what it looks like after a parse-and-serialize cycle (`normalized`).
Each block carries an id into the editor.

On save, a block is written back as its **original bytes** when it still has its id
and still serializes to the same `normalized` text. Otherwise it is written freshly
serialized. The whitespace between two blocks is reused only when they were
neighbours in the original too.

A construct the editor does not model — a table, an image, raw HTML, a footnote — is
represented as an opaque raw block showing its source. It cannot be edited yet, and
it is always written back untouched.

## Consequences

- Editing one paragraph produces a one-paragraph diff. Everything else, including
  `*` bullets, setext headings and hard wrapping, is preserved exactly.
- A block the user _does_ edit is normalized to this project's markdown style. That
  is the trade: predictable output where you typed, byte-fidelity everywhere else.
- Unsupported constructs are safe but read-only until the editor models them.
- The guarantee is enforced by tests, not by inspection: a corpus of 37 documents
  must round-trip byte-identically, and for a document containing one of every
  construct, editing or deleting any single block must leave every other block
  byte-identical.

## Alternatives rejected

- **A markdown-aware ProseMirror serializer for the whole document.** Simpler, but
  reformats the entire file on every save.
- **Storing the ProseMirror JSON as the source of truth.** Abandons the plain-text
  vault, which is the point of the project.

## Addendum: two lists that come to stand side by side (#569, 2026-10-25)

Moving or deleting a block can leave two untouched lists next to each other.
To markdown they are one list if their markers match (`-` and `-`, or `1.` and
`1.`), blank lines or not, and on the next read the second list's `^id` would
belong to the merged list. There is no byte-free way to keep them apart: only a
block between them, or a different marker, does.

So the save writes **the list after** afresh with the markers the list before
does not use (`*` after `-`, `1)` after `1.`; `+` when both are taken), the way
`markersBeside` already chose a freshly rendered list's markers. The list before
keeps its bytes, and a `^id` on a line of its own between the two already keeps
them apart and changes nothing. This is the one case where an untouched block is
not written from its bytes: the note must read back as the two lists the person
sees, each with its own id, and that outranks the bytes of one list.
