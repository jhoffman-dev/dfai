---
type: adr
id: ADR-0043
title: A highlight is a quote block in its literature note, with an id and a hidden anchor
status: proposed
date: 2026-10-21
---

# ADR-0043 — A highlight is a quote block in its literature note, with an id and a hidden anchor

## Context

The research and study area (epic #509) reads PDFs and EPUBs in the app,
takes highlights and underlines with a comment on each, pulls highlights into
other notes, opens the document at a highlight's place, and brings Kindle
highlights in the same way. Five later pieces read and write one format —
the PDF reader (#504), EPUB (#505), jump-to-location (#506), the library
(#507) and Kindle sync (#508) — so the format is decided first (#503).

What it has to hold to: markdown is the truth and the index is derived
(ADR-0005); untouched bytes stay untouched (ADR-0003); block ids are
Obsidian's (ADR-0022), so `[[Source#^id]]` and `![[Source#^id]]` need no new
grammar; a marker DFAI reads is hidden from every other reader (ADR-0020);
every type has a home folder (ADR-0038). And the note must read well in
Obsidian, where the person will also edit it.

Options weighed for where a highlight lives:

- **In the PDF itself** (annotations). Every reader shows them, but DFAI would
  write into a file it did not make, sync would carry a changed binary, and an
  EPUB or a Kindle book has nowhere to put one.
- **In a sidecar file** (JSON beside the PDF). Easy to write, but invisible in
  Obsidian, outside the index's notes, and no block id can name it.
- **In a note, one block per highlight.** Readable anywhere, linkable by
  `^id`, searchable, synced like any note. Chosen.

## Decision

1. **One literature note per source.** A PDF or EPUB lives in the vault, in its
   type's home folder, `Library` by default (ADR-0038's table gains
   `literature → Library`), and syncs with it. DFAI never writes into the file,
   so it stays byte-identical. Its note declares what it is:

   ```markdown
   ---
   type: literature
   kind: pdf
   title: 'The Art of War'
   author: 'Sun Tzu'
   file: '[[Library/The Art of War.pdf]]'
   ---
   ```

   The type is `literature`, after the Zettelkasten literature note: the note
   you write about something you read. It is not `source`, which a data
   source's `atlas: source` already reserves (so a `source` type file could
   not be defined). `kind` is `pdf`, `epub` or `kindle`. A Kindle book has no
   file in the vault, so it has no `file`; it may have an `asin` (Amazon's id
   for the book), and a Kindle sync finds a book's note by `asin`, falling
   back to its title and author. DFAI writes every value quoted; it reads a
   `file` written as a link (alias or heading aside) or as a bare path.

   The `file:` is a wiki link, and `#`, `^`, `|`, `[` and `]` mean something
   inside one, so a file with one in its name would read back as another
   file. The writer refuses it (`UnsafeSourceFileError`), and the importer
   (#504) names the files it saves with `safeSourceFileName`, which makes
   each of those characters a hyphen.

2. **A highlight is one quote block, then its id.** The quoted words, the
   hidden marker, and the person's comment are all one quote; the block's
   `^id` sits on a line of its own after it, a blank line between, as
   ADR-0022 writes a quote's id:

   ```markdown
   > All warfare is based on deception.
   > <!-- atlas:highlight {"v":1,"mark":"highlight","color":"yellow","kind":"pdf","page":3,"exact":"All warfare is based on deception.","prefix":"Sun Tzu said: ","suffix":" Hence, when","rects":[[0.12,0.31,0.62,0.02]]} -->
   >
   > The line every summary quotes. Compare [[Larkspur Payroll]]'s pitch.

   ^k3x9q2
   ```

   The marker parts the quote from the comment: the lines before it are the
   quote, the lines after it the comment. So `![[The Art of War#^k3x9q2]]`
   shows the quote and its comment, and `[[The Art of War#^k3x9q2]]` opens
   the note at it. In Obsidian's reading view, on GitHub and in any
   CommonMark reader the marker is invisible.

   The format stays this: not a callout, and not a nested quote for the
   comment. The blank `>` line DFAI writes between the marker and the
   comment only separates them (the quote is the lines before the marker, the
   comment the lines after it). A comment line that lost its `>` in Obsidian
   is a CommonMark lazy continuation, still part of the quote there, so it is
   still part of the highlight; the next comment write puts the `>` back.
   Where the quote ends is the markdown parser's answer (§8), not a list of
   line rules: a heading, a thematic break, a fence, an HTML block or a list
   item without its `>` ends it, and what follows is then no highlight;
   words, inline HTML, an autolink or a setext underline (`===`) stay in it.
   A list item ends the quote whether or not it could interrupt a paragraph
   (`-`, `1.`, `2. more`): the line is outside the quote, so there is no
   paragraph of the quote for it to interrupt, and CommonMark starts the list
   there. A quote line may have up to three spaces before its `>`, as
   CommonMark allows, and is still the quote's.

3. **The marker holds the anchor and the style, as one line of JSON.**
   `<!-- atlas:highlight {…} -->`, `atlas:` as every marker is (ADR-0042),
   `v` its version. `<` and `>` in the JSON are written `<` and
   `>`, so no quoted words can close the comment. The anchor is:

   | Kind     | Fields                                                                                           |
   | -------- | ------------------------------------------------------------------------------------------------ |
   | `pdf`    | `page` (from 1), `exact` + `prefix` + `suffix`, `rects` as `[x, y, w, h]`                        |
   | `epub`   | `cfi` (`epubcfi(…)`), `exact` + `prefix` + `suffix`                                              |
   | `kindle` | `location` (from 1) or `page` (from 1), optional `locationEnd`, optional `annotationId`, `exact` |

   `exact`/`prefix`/`suffix` is the W3C TextQuoteSelector. A Kindle highlight
   has `location` or, for a book whose export has pages and no locations,
   `page`; its `exact` is the export's own words, written when it is added. A PDF box is in
   fractions of its page from the top-left, so it holds at any zoom. A part
   of a run of text is cut along the way the run reads, from its first
   letter — down a page turned a quarter, leftward on one upside down, down
   a column of a font written top to bottom — and stored as the box round
   that part, so `rects` keep one shape whatever the page's turn. A PDF
   highlight with no words — an area on a scanned page — has no `exact` and
   at least one box. Its quote is a picture of the area, saved among the
   vault's images and embedded as the quote's line — `> ![[attachments/The Art
of War p4 area.png]]` — so the highlight shows something wherever it is
   transcluded (#504). The embed is markdown DFAI writes, not the source's
   words, so it is not escaped; a picture whose path a link could not name
   (`#`, `^`, `|`, `[`, `]`, a line break) is refused with
   `UnsafeSourceFileError`; the picture is named from the PDF's name with those
   characters made spaces and the name cut to fit a file name once numbered. The
   picture is written only for a highlight that is added: a note with unsaved
   typing, or one that already holds the area (`heldHighlight`, asked before
   the picture is drawn), writes none, and a picture written for a highlight
   the note then refuses goes to the Trash again — but only once the note,
   read again, does not embed it, since a write can land and still report a
   failure (a lost answer, a pane's reload failing). Removing
   an area highlight takes out the block and **keeps the picture**: it is a file
   in the person's vault that DFAI will not delete on their behalf, another note
   may embed it, and an orphan costs only disk space. The style is `mark` (`highlight` or `underline`) and
   `color` (yellow, green, blue, pink, purple, orange); one this build does
   not know is drawn as a yellow highlight, and its bytes are kept.

   The marker is one line and hides in every reader: `<`, `>`, U+2028 and
   U+2029 are written as JSON escapes (a PDF's text layer holds the last two,
   which some readers take for a line end). A marker whose JSON holds a raw
   `-->` is not read, since CommonMark ends the comment there and shows the
   rest as text. An anchor is refused when its `exact` (a Kindle one's too)
   is empty or only whitespace, or a
   PDF box runs off its page (past the right or bottom edge, within a rounding
   of 1e-6).

4. **The quote and comment are the person's; the anchor is the source's.**
   The person may edit the quote — tidy an OCR slip, cut it shorter — and the
   comment, in DFAI or in Obsidian; the marker and the `^id` stay. The anchor
   keeps the source's own words in `exact`, so a tidied quote still finds its
   passage. DFAI writes the quote from the source's words escaped as text,
   one line per paragraph (a PDF's line breaks are its page's, not the
   author's), so `*`, `#word`, `==`, `%%` or `^id` in a book never become
   markup, a tag, a highlight, a comment or an id. A paragraph that is only a
   list number (`1.`, `2)`) is escaped too, since alone it is an empty list
   item. A comment is the person's markdown and is written as given, but for
   two escapes: a line that would read as a second marker gets `\<`, and a
   `%%` that would leave an Obsidian comment open past the comment's own
   text gets `\` between its `%` (`50%%` is written `50%\%`, which Obsidian
   shows as `50%%`). Marks are counted as §8 counts them: only in text,
   never in a fenced or indented code block, an inline code span or inline
   HTML, one per pair of `%` in a run (`%%%` is one mark and a stray `%`).
   A comment whose count is even is balanced and cannot hide what follows
   it, so a `%%private%%` the person wrote stays as written; code with a
   `%%` in it keeps no backslash. An odd count escapes marks, last first,
   until it is even, and what is written no longer holds an unbalanced
   mark, so escaping again changes nothing. This reads the comment on its
   own, so a `%%` that closes one opened in the quote (a hand edit) is
   escaped as unbalanced, and a balanced comment after such a quote would
   open one: both are left to the postcondition in §5, which refuses the
   write. Markdown with neither escape is kept byte for byte, so a comment
   written back as it reads — saved unchanged, or left alone while another
   highlight is edited — is the same bytes, for balanced comments and code.

5. **Writes change only their highlight's bytes** (ADR-0003). Adding appends
   a block after the note's last byte, after a blank line of its own — never
   one the note already ended in, which is the person's — and at the very
   start of an empty body with none. A new comment
   replaces the comment's lines and nothing else; written back as it reads,
   a comment is the same bytes. Removing takes out the block and the one
   blank line that parted it. A highlight is removed only on the person's
   command: nothing removes one by itself, sync included. **A removed Kindle
   highlight leaves a tombstone** in the block's place, so a sync does not
   bring it back (#508, review of PR #514):

       <!-- atlas:highlight-removed {"v":1,"kind":"kindle","location":9,"annotationId":"A1","words":"3f2a…"} -->

   It is a line of its own, an HTML comment like the marker (ADR-0020's
   style, `atlas:` kept, `<`, `>`, U+2028 and U+2029 written as `\u` escapes),
   so Obsidian's reading view, GitHub and every CommonMark reader hide it and
   DFAI reads no highlight in it. It keeps where the highlight was, its
   annotation id and a hash of its words (`hashOf` of the words as a key reads
   them) — not the words, which the person removed — which is exactly what the
   highlight's Kindle key is made of. The blank lines round it stay as they
   were; every other write changes only its own bytes, so a tombstone survives
   comment edits, other removals and appends, and the person deleting the line
   is how a removed highlight is allowed back. Removing a highlight of another
   source (PDF, EPUB) leaves nothing, and removing all that were added gives
   the note back byte for byte for those. `looksLikeHighlightMarker` does not
   take a tombstone for a marker it cannot read (`atlas:highlight` must not be
   followed by `-` or a word character), so a note holding tombstones is not
   refused. A note with no final
   newline stays so: the block is written without one, and removing it gives
   the note back byte for byte. So removing every highlight added gives the
   note back byte for byte (for PDF and EPUB highlights; a Kindle one leaves
   its tombstone), whatever it ended in (`\n\n`, `\n  \n`,
   `\r\n\r\n`, no line ending). A byte order mark that starts a note with no
   frontmatter is the file's, not the body's: a block is written straight
   after it, and no write moves or removes it. Each write goes
   through the vault against the version just read, and is refused while a
   pane holds unsaved typing in the note (as linking a block is, ADR-0022).

   Every write checks itself before it is written. Each highlight the note
   read before the write — but the one removed — and each one added must
   read back from the note it would write, parsed again as §8 parses it, or
   `HighlightNotReadBackError` is thrown, naming them, and nothing is
   written. So a note that ends inside an unclosed code fence, raw HTML
   block (`<pre>`, `<script>`, `<style>`, `<textarea>`), HTML comment or
   Obsidian `%%` comment refuses an append that it would hide, which every
   sync would otherwise add again; and a comment edit or a removal that
   would let a `%%` the person put in a quote, a comment or the words
   between blocks open a comment that hides the highlights after it is
   refused too, and so is a comment whose balanced `%%` pair would pair with
   one the quote opened and open another. And a note that holds a marker this build cannot read
   (a newer version's, or one broken by hand) is refused with
   `UnreadableHighlightMarkerError`, because that marker may be a passage the
   build would add a second time; editing a comment or removing a highlight
   still work around it.

6. **Ids per ADR-0022.** Six lower-case letters and digits from the injected
   `Rng`, never one a line of the note could already be read as holding.

7. **Adding a passage twice adds it once.** What makes two highlights the
   same passage is `highlightKey`: a PDF page and its selector (so a PDF
   key relies on `prefix` and `suffix` to tell two copies of a phrase on one
   page apart), a PDF area's page and boxes, an EPUB CFI, Kindle's
   `annotationId`, or without one a Kindle place (location or page) and the
   export's words, `exact`, never the quote as the person has since edited it.
   An export that learns an annotation id later still matches the copy synced
   without one, on place and words (`sameKindlePlace`). Places are compared,
   not keyed, since one export may give a location and a page where another
   gives either: by where the location starts when both have one — My
   Clippings gives `Location 77-79` where the notebook export gives
   `Location 77` — else by page when both have one (`page 5 | Location 77-79`
   and a notebook export's `Page 5` are one passage, whichever came first);
   two that share neither are two passages, as are two different words at one
   place and two different ids. An export that gives blank words for `exact` gives none, and the
   quote stands in for them.

   Being the same place is not transitive — a copy with a page alone is the
   same place as two copies at different locations on that page, which are
   not the same place as each other — so matching is one passage to one
   passage. A highlight of an append joins a passage only when it is the
   same place as every copy already in it, with no two annotation ids; so a
   held copy is claimed by at most one passage of the export, two highlights
   with different ids are always two passages, and two blocks the note holds
   are never one passage. The held blocks are matched as if they were
   highlights of the append: every key — a held block's, an incoming
   highlight's, or both — is placed in one order, not the export's and not
   by which of them the note already holds: those with a location, each
   taking a passage at its location before one with a page alone; then
   those with a page alone; among each, by key. A key is placed as the note
   holds it, else as it would be written. A passage a held block is in
   answers that block; any other is written. Since a block a sync writes
   has the key of the highlight it was written from, a sync run again
   places the same keys the same way, and every passage it finds holds its
   block: it adds nothing. Placing a key as the note holds it keeps a sync
   handed only part of that export from moving it, so that adds nothing
   either (property-tested, not proven). (Matching the held passages first, then the export, broke
   this: a located copy that had joined a page-only held block took, on the
   next sync, the block its located sibling had written, and the page-only
   copy that had joined that sibling was appended again — PR #510, property
   seeds 101 and 303.) Every order of one append gives the same note. An
   export that grew between syncs gives as many passages as one synced at
   once, as long as each export is one shape (all with locations, or all
   with pages alone, a location always on one page); one that mixes shapes
   in one export can pair its copies differently as it grows, but a sync
   run again still adds nothing.
   Adding one the note holds answers the id it has. So a Kindle sync can hand
   over every highlight each time.

8. **The markdown parser finds the blocks; the domain reads them.** Which
   lines are a top-level block quote is answered by the CommonMark parser
   that renders the note (`mdast-util-from-markdown` / micromark with GFM, as
   the editor and the index use it), through the markdown port's
   `noteBlocks(text)`: each top-level block quote's span, the top-level
   paragraph straight after it, and what Obsidian `%%` comments hide. The
   domain takes that as `NoteBlocks` and reads only a quote's own lines:
   a highlight is a top-level block quote holding exactly one marker this
   build reads with words before it, then exactly one blank line and a
   paragraph of one line that is `^id`. A quote without the id, with two
   markers, a broken or newer marker, inside a list item, or inside a fence,
   indented code, an HTML block or comment — closed or not, since the parser
   runs an unclosed one to the end of the note, and ends one opened in a list
   item with the item — is not a highlight, and is kept exactly as written.
   An earlier draft tracked fences, HTML blocks and list items line by line;
   three rounds of verification kept finding notes where it and the renderer
   disagreed, so the rule went to the parser.

   Obsidian's `%%` comments are not CommonMark, and no parser here reads
   them, so they are approximated over the parse: a `%%` counts only in text
   the parser reads as words — never in a fence, indented code, a code span
   (of any number of backticks), an HTML block or comment, or inline HTML —
   and each pair hides from the first to the second, one left open to the end
   of the note. A highlight whose first line is hidden is not one. Where
   Obsidian may read it otherwise — a `%%` inside code that sits within a
   comment does not close the comment here — DFAI errs to reading the comment
   as still open, which at worst refuses an append (`HighlightNotReadBackError`)
   rather than writing a highlight nobody sees. The parser reads no maths,
   so `$…$` is text and a `%%` in it counts, where Obsidian, which renders
   maths, may read it otherwise. Only a note that says
   `type: literature` has highlights; the same text pasted elsewhere is a
   quote.

9. **Re-anchoring uses the words first.** `findQuote` looks for `exact` in a
   page's or chapter's text, whitespace compared loosely, and of two copies
   takes the one whose surroundings match `prefix` and `suffix`;
   `findQuoteNear` looks on the named page first, then outward. So a file
   downloaded again, or another edition, still finds its highlights; changed
   words are not found rather than found in the wrong place. Space at either
   end of `exact` counts as surroundings, so a selection that began on a space
   finds its own copy. A copy wins only on surroundings that are not
   whitespace: only the non-whitespace characters of `prefix` and `suffix`
   it matches count, so copies whose surroundings differ in whitespace alone
   tie, and copies that tie are no match at all rather than the first. The page `near` is made a section index first: a fraction rounds
   down, a number out of range is the nearest end, and NaN is the first.
   A PDF highlight whose own page cannot be read is drawn at its saved boxes
   on that page: its words there are unknown, not missing, so a copy of them
   on another page is not taken for it. A page that failed to read is read
   again the next time it is asked for.

10. **The index has a `highlights` table** (schema 19; searched since schema 20, #507): `path, idx, id, kind,
quote, comment, mark, color, anchor` — the quote's plain words, the
    comment's markdown, and the marker's JSON. TypeScript reads the rows
    (`highlightRows`); Rust stores them (ADR-0005). `/v1/sql` reads it.

11. **How a Kindle sync writes into this format** (#508, ADR-0044). The rules
    are the domain's (`domain/kindle/kindle-note-match.ts`,
    `kindle-note-writes.ts`); the sink (`literatureNoteKindleSink`) only
    finds, makes and writes the note.
    - **Which note.** The one whose `asin` is the book's; else one with no
      `asin` whose title and author are the book's (case, spacing, Unicode
      composition, apostrophes and quotation marks — `’ ‘ ʼ '` — and
      characters that show nothing, such as a zero-width space, aside). Never the title alone: a book or note with no author
      is found by ASIN only, and a note naming another ASIN is another
      edition's. The literature notes the index knows of and the files in the
      literature home folder are looked through, so a note made a moment ago
      and not yet indexed is still found. They are read **once per sync**
      into a lookup by ASIN and by title and author (`kindleNoteIndex`),
      books with no note included; each note found is read again before it is
      written to, so one renamed or retitled meanwhile is looked for afresh.
    - **A new note** is `literatureNoteText({ kind: 'kindle', title, author,
asin, file: null })` in the literature type's home folder (`Library` by
      default), named by `kindleNoteName`: the title with the characters a
      wiki link reads as its own syntax (`#`, `^`, `[`, `]`, `|`) and what
      shows nothing taken out (`linkableEntryName`), so `![[Book#^id]]`
      reaches its highlights, and cut by whole characters (`fitFileNameStem`)
      so that a number and `.md` after it fit the 255 bytes a disk takes, a CJK
      title included. It is numbered past any name taken (`Persuasion 2.md`,
      `nextAvailableNotePath`, in any case) so no note is written over, and
      made with its highlights in the same create; a name taken between the
      listing and the create is the disk's refusal, and the name is chosen
      again (three tries). The title property keeps Amazon's title as given. A
      book none of whose highlights can be placed gets no note yet.
    - **One write per book.** The whole change — new blocks, then comments —
      is one pure rewrite (`withKindleHighlights`, built on `appendHighlights`
      and `withHighlightComment`) written once through
      `changeLiteratureNote`, against the version just read: all of the book
      or none of it, as the sink's port promises. A pane with unsaved typing
      in the note is never written behind: the book is skipped that sync
      (`unsaved_typing`, said by title) and comes next time.
    - **Typed notes.** A note typed on a passage is the passage's comment. One
      that arrives after its passage synced — typed later, or Kindle's edit of
      one — goes **after** what the comment already says, as a paragraph of its
      own (the whole comment when it has none). It never replaces the comment,
      not even when the comment is word for word what DFAI wrote: once in the
      vault those bytes are the person's (ADR-0003), and keeping both costs one
      paragraph. The paragraph is **inserted after the comment's last line**
      (`withHighlightCommentAfter`) — a blank `>` line and the note's lines — and
      the comment before it is not touched, whoever wrote it and however it
      is spelled (`>first` stays `>first`). A note at a place with no passage is a block of its own whose
      quote names its place (`Note at location 2400`), its words the comment
      and the marker's `exact`.
    - **What is recorded is read from the note**, nowhere else: a passage by
      its marker (annotation id, else place and `exact`), a typed note by its
      words standing whole as paragraphs of its passage's comment — every run
      of consecutive paragraphs, anywhere in a comment of any length, with no
      cap — keyed as written and as typed (a `%%` DFAI wrote as `%\%`, and a
      line that would read as a marker, are read back as typed:
      `undoCommentEscapes`), so a note with a `%%` in it is added once, not on
      every sync; and a passage the person removed by its tombstone (§5), with
      every note typed on it. So a typed note the person edits in the vault no
      longer reads as recorded, and Kindle's words arrive once more, after the
      edit — never over it.
    - A Kindle highlight with no location and no page in figures (a page
      `xiv`) has no place this format holds. It is **skipped, and said so**
      ("1 highlight couldn't be placed (page xiv)"): the rest of its book is
      written, a note typed on it is skipped with it, and the next sync tries
      it again, which writes nothing while it still has no place. What a write
      says it wrote (`written`) counts only entries that changed the note, so
      the sync's "Added N" is what the notes took.

12. **A highlight followed opens where it lives** (#506). A link to a
    highlight, `[[Source#^id]]`, its embed's source chip, and the "Open in
    PDF" a highlight offers in its own note open the source's reader at the
    highlight, scrolled to it and flashed, when the app has a reader for the
    source's kind (`READER_KINDS`: `pdf` and, since #505, `epub`) and the note
    names its file. Anything else — a Kindle book, a block of the note that
    is no highlight, a note that is no literature note — opens the note at
    the block, as ADR-0022 has every block link do. The rule is the
    domain's (`highlightOpening`); `whereHighlightOpens` and
    `openHighlightPlace` are the application's, for links and for the
    library's rows. An embed of a highlight wears a chip of its source's
    title and its page (`p. 3`) or Kindle location (`loc. 41`), in its
    kind's pastel. A highlight whose words are not found opens at its saved
    page, and the reader says it could not find the exact spot.
    The reader opens only a file it can read: a `kind: pdf` note whose
    `file:` is not a `.pdf` opens its note at the block and offers no
    "Open in PDF".

    `[[file.pdf]]` names a PDF of the vault, found among the vault's real
    files, not the literature notes, so a PDF with no literature note is
    found. The host lists them in one walk (`list_vault_files`, told what to
    skip and how deep as the note walk is, ADR-0014): it does not follow a
    link to a folder, leaves out a folder it cannot read, and fails only
    when the vault itself cannot be read; the hidden entries are left out
    in TypeScript (`isVisibleEntry`). Names are compared with accents
    composed and case folded, as note links are, so a file written
    decomposed is found by a link typed composed. As in Obsidian a link writes the
    end of a path: `[[reading.pdf]]` or `[[Courses/reading.pdf]]` matches
    `Library/Courses/reading.pdf`. Where several files match, one is picked
    the same way every time: the exact path, else the shortest path, else
    the first alphabetically. A link never opens a path no file has; where
    no PDF matches, the link is read as a note's (`[[Budget review.pdf]]`
    opens a note of that name), and where neither exists it says "No PDF or
    note called …". `[[paper.pdf#^id]]` opens at that highlight and
    `[[paper.pdf#page=3]]` at page 3; an id the PDF's note does not have
    opens the reader, which says it couldn't find that highlight.

    A link whose target takes a read to know opens late, so it opens only
    while the vault it was clicked in is still the open one, it is still
    the latest click on its surface (a pane, or the peek), and the tab it
    was made in still shows what it showed — in the peek, the same opening
    of the peek, not just the same note; a ⌘-click opens a tab of its own
    and needs only its pane, found by the pane's key, so a pane renumbered
    by another's closing still gets it. A reveal a reader tab holds
    belongs to its document and is spent: another PDF in the same tab, or
    coming back, is not brought to it. The chip, "Open in PDF" and an
    embed's name are links in the tab order and follow on Enter, with the
    click's modifiers. A key pressed on any such control drawn inside the
    note — not editable, its nearest `contenteditable` false — is the
    control's, never the editor's (`ControlKeys`): no keymap sees it. On a
    focused non-field control inside the document, Backspace, Delete,
    Enter (with any modifiers), typed characters and ⌘/Ctrl+z/y/b/i/u are
    kept from the browser as well as the editor, so no key on it changes
    the note or goes Back; fields keep every key, and buttons keep Enter
    and Space. Tab, Escape, the arrows and composition keys are left alone.
    This runs as a capture-phase listener on `view.dom`, not
    `handleDOMEvents`, because a React node view's `stopEvent` hides keys
    from ProseMirror's handlers. It also fixes #529, a bug on main.

## Consequences

- A literature note reads as a list of quotes with comments in Obsidian; its
  highlights link and transclude with Obsidian's own grammar; search finds
  quotes and comments and never the marker.
- DFAI's editor draws a highlight as its quote, in its mark's muted pastel,
  with its comment under it as a field (#523); the marker is never drawn, nor
  is a tombstone. The block is still one raw atom of the note, saved from its
  bytes; a comment typed in place is written by `editHighlightComment`, after
  the pane's own typing is written, so it is byte-preserving, `%%`-escaped,
  read back before it lands, and refused while typing elsewhere in the note
  is unsaved. Whether a block is a highlight is the note's answer in place
  (`literatureHighlightReader`); what it shows is read from the block's own
  bytes (`highlightView`). An embed of a highlight draws the same quote and
  comment, read-only, under its source chip. The quote is not edited in
  DFAI — it is the source's words; a person who wants to tidy one edits the
  note in Obsidian or any text editor, as §4 allows.
- The domain's public API — `appendHighlights`, `withHighlightComment`,
  `withoutHighlight`, `readHighlights`, `findQuote`, `literatureNoteText` — is
  pure, and takes the note's blocks as a `noteBlocks` function (the markdown
  port's), so DFAI, its index and the editor read every note alike; the
  application's `addHighlight(s)`, `editHighlightComment` and
  `removeHighlight` are the vault writes the readers and sync call.
- The note type is `literature`, so a vault can define a `literature` type
  file (its views and columns) and the library (#507) reads it from
  `files.note_type`; the `highlights` table holds the rest.
- A marker of another version is left alone, so an older DFAI on another Mac
  never rewrites a newer one's highlights.

## Addendum: the research views (#507)

- **The Library and All highlights are pages of their own, not built-in
  query views.** A query view lists notes, one row per note, with the
  note's properties as columns; All highlights lists blocks, many per note,
  and the Library's rows need a count of a table the query language does not
  reach, a cover read from the vault, and a kind chip. Both reuse what the
  query views are built from — the index's read-only `query`, the scoped
  reads that refresh only on news of literature notes (ADR-0040), and the
  virtualised rows — and keep their filters and order in the domain
  (`filterLibrary`, `sortLibrary`, `filterHighlights`, `inDisplayOrder`).
- **All highlights reads the `highlights` table by key**, `(path, idx) >
(?, ?)` down `highlights_path_idx`, and not by offset (the last page of
  150,000 highlights would cost sixty times the first). The statement keeps
  to literature notes in use (`path IN (SELECT path FROM files WHERE …)`,
  the Library's own test); the reader matches each row to the Library's read
  of those notes by path, for the title, time and tags. A page is 2,500 rows,
  so four-byte characters in every quote and comment stay under the host's
  16 MiB answer. A change to a literature note re-reads only that note and
  is spliced into what was kept; news that does not say which notes changed
  reads it whole.
- **A `type:` list that holds `literature` is a literature note**
  (`[literature, book]`): `isLiteratureNote` reads a list as the index's
  type check does, so the Library's rows, its highlight counts, All
  highlights and ⌘K never disagree about a note.
- **A highlight keeps no day of its own** (§3), so "date" filters by when
  its literature note last changed.
- **Search reaches highlights** (schema 20): each highlight's quote and
  comment have a row in `highlights_fts`, keyed by the highlight's rowid, and
  `index_search` answers them after the notes when the frontend asks
  (`highlights`), each naming its block. The marker's JSON is not searched.
- **A highlight is dragged into a note as its embed**: the row carries
  `![[Source#^id]]` as text, and the block embed's own HTML, which the
  editor's drop parses into the embed node, as a paste would.

## Addendum: the EPUB reader (#505)

- **foliate-js reads the book; DFAI shows it.** foliate-js (MIT, pinned at
  1.0.1, bundled in the EPUB reader's own chunk) reads the package, contents,
  metadata and CFIs, and its vendored zip.js the archive. Its own renderer is
  not used: it loads each chapter from a `blob:` address into a frame, which the
  app's `frame-src 'none'` refuses, and it needs `allow-scripts` with nothing
  but a page-wide policy to hold a book's scripts back. epub.js was the other
  choice; it has had no release since 2022 and renders the same way.
- **A chapter is made safe, then shown in a frame of DFAI's own, with an
  opaque origin.** How, and why it is not the `allow-same-origin` frame this
  addendum first described, is ADR-0045: the chapter is cleaned in the reader
  (`makeChapterSafe`), handed as data to DFAI's one script in a
  `sandbox="allow-scripts"` frame whose policy runs only that script, by its
  hash, and the book's files go in as `data:` addresses, never `blob:` ones of
  the app's origin.
- **A safe chapter keeps every node where it was.** What is taken away leaves
  an empty, hidden element in its place, and a stylesheet `<link>` becomes a
  `<style>` in its place, so a chapter's elements are counted as the book's
  file counts them and a CFI made in DFAI names the same place in any reader.
  Highlights and find's matches are drawn with the CSS Custom Highlight API and
  the reader's own styles are adopted, so neither adds a node either. (The
  frame builds its own copy of the chapter; places in it are offsets of the
  chapter's text, so the copy need not match node for node: CFIs are made and
  read on the reader's parsed chapter.)
- **A chapter's text** is its body's words in order, a line break where a block
  begins or ends, nothing of the head, scripts or styles (`chapterText`). A
  selection is a stretch of it; its selector is the words as they read — every
  run of space one space — and the quote written is those words.
- **Placing a stored EPUB highlight** (§9): where its CFI points when the words
  there are its own (`placeInCfiSection`); else its words in the CFI's chapter;
  else every chapter, nearest the CFI's first (`placeByBookWords`); else lost,
  listed as not found. Only the chapters needed are read.
- **DRM is refused before the book is read** (`epubProtection`): a book whose
  `encryption.xml` encrypts anything by a cipher, obfuscates a file that is no
  font, or names no method, or that carries Adobe's `rights.xml` or Apple's
  `sinf.xml`, is protected; the font obfuscation the EPUB standard and Adobe
  define is not DRM. Adding one is refused, said plainly, with nothing written.
- **Adding an EPUB** is ⌘K "Add EPUB…", a command of its own beside "Add PDF…":
  the shipped PDF command keeps its name, and each picker offers only its own
  kind, so a wrong file is refused by name. The copy, the note and the refusals
  are one use-case for both (`addToLibrary`).
- **Not done here:** a font obfuscated as the EPUB standard allows is shown in
  the book's fallback font (foliate-js's decoder is private to its renderer);
  pages are not paginated, a chapter scrolls; fixed-layout books are shown as
  reflowable.

## Alternatives rejected

- **A callout (`> [!quote]`).** Reads well, but the callout's own title line
  would hold the source or page, which the person then edits as words.
- **The comment as a paragraph after the quote, outside it.** An embed of the
  `^id` would show the quote alone, and the comment would belong to no block.
- **The anchor in frontmatter, keyed by id.** One place for every anchor, but
  every highlight write would rewrite the frontmatter, and a highlight copied
  to another note would lose its place.
- **Key=value pairs in the marker.** Shorter, but quoted words with `=`, `"`
  or a line break need an escaping scheme of their own; JSON already has one.
