---
type: adr
id: ADR-0045
title: A book is shown in a frame with an opaque origin, and only DFAI's script runs there
status: proposed
date: 2026-10-23
---

# ADR-0045 — A book is shown in a frame with an opaque origin, and only DFAI's script runs there

Part of #505 (the EPUB reader). Replaces the frame ADR-0043's EPUB addendum
first described; the rest of that addendum stands.

## Context

An EPUB is untrusted: anyone can write one, and people download them from
anywhere. Its chapters are XHTML, and may hold scripts, handlers, pictures and
fonts on other sites (beacons), frames, forms, refreshes, `javascript:` links,
and links in places a sanitiser does not think of.

The first design showed each chapter in a `srcdoc` frame sandboxed
`allow-same-origin allow-scripts`, so the reader could reach into the frame to
read the selection and draw highlights; the book's files were given `blob:`
addresses of the app's origin. A review proved that one gap in the cleaning was
enough: `<math><mtext href="evil.svg">` kept its `href` as a file to load, the
file became a `blob:` typed `image/svg+xml`, WebKit treats a MathML `href` as a
link, the reader stopped clicks only on `<a>` and `<area>`, and a click led the
frame to the blob — an SVG document of the app's origin whose script had the app
as `window.parent`, and with it the IPC. Only `index.html`'s unrelated
`frame-src 'none'` stopped it. The e2e test `epub-reader.hostile.spec.ts`
reproduces it on that design with that line removed: the frame's address became
`blob:http://localhost:…/…`, the script set a value on the app's window, and the
host was called.

The lesson is that the frame itself must be unable to hurt the app whatever the
cleaning misses.

## Decision

1. **The frame's origin is opaque.** It is `sandbox="allow-scripts"`
   (`EPUB_FRAME_SANDBOX`), without `allow-same-origin`. Nothing in it — DFAI's
   script, or a book's that got past everything else — can reach the app's
   window, storage or IPC, and anything it is led to stays opaque. No forms,
   pop-ups, or navigation of the window.

2. **Only DFAI's script runs in it, named by its hash.** The frame's document is
   DFAI's: a policy first (`epubFramePolicy`), then one inline script. The policy
   is `default-src 'none'`, `script-src 'sha256-…'` of that script and nothing
   else, `style-src 'unsafe-inline'`, pictures, fonts and media only `data:`, and
   no request, frame, worker, object, form or `<base>`. The script is made from
   `packages/adapters/src/epub/frame-bootstrap.ts`, `text-positions.ts` and
   `unshadowed-dom.ts` by
   `tools/epub/frame-bootstrap.ts`, which writes it and its hash into
   `frame-bootstrap.generated.ts`; a unit test makes it again and fails when the
   committed file is not what the sources make, and checks the hash in the
   policy is the script's.

3. **The book is handed over as data; nothing comes back as markup.** The reader
   (the parent) cleans the chapter, then hands the frame its nodes as a flat list
   (`chapterSource`): elements by namespace, name and attributes, texts with the
   offset their words begin at in the chapter's text. The frame builds them
   itself with the DOM — no HTML or XML is parsed there. The book's pictures,
   fonts and stylesheets are written in as `data:` addresses (`bookFiles`), never
   `blob:`: a `data:` document is opaque wherever it is opened.

4. **The message protocol** (`frame-protocol.ts`), by `postMessage` only:
   - reader → frame: `style` (the reader's CSS, set as an adopted sheet),
     `chapter` (the nodes and the text's length; one per frame), `paint` (names
     to clear by prefix, and groups of `[start, end)` offsets under `dfai-…`
     names, drawn with the CSS Custom Highlight API), `scroll-to-offset`,
     `scroll-to-fragment`, `clear-selection`;
   - frame → reader: `ready` (the script runs), `shown`, `selection` (offsets and
     its box in the frame's viewport, on a press or key let go, or a scroll),
     `link` (a book path and fragment, never a URL), `key` (name and modifiers).

   Each side reads every message against the protocol and drops what does not
   fit. The reader takes a message only from its frame's window with origin
   `null`, and checks offsets against the chapter's length, paths and keys
   against length caps, boxes for finite numbers. The frame takes a message only
   from the window that made it, and caps nodes (2,000,000), strings (32 MB),
   paint groups and ranges; a paint with any group out of the chapter, or under
   a name it does not clear, draws nothing. A frame whose script never says
   `ready` by a task after it loads is a failure, said as one, and taken away.

5. **Defence in depth.** Each layer assumes the others failed:
   - the reader's cleaning (`makeChapterSafe`) still takes out scripts, frames,
     plug-ins, `<base>`, `<meta>`, handlers, SVG animation, form actions and
     references off the book; it now keeps `href` only on links (`<a>`,
     `<area>`) — kept as the book path they lead to, `data-dfai-path` — and on
     SVG's resource loaders (`image`, `use`, `feImage`, `pattern`, `textPath`,
     `linearGradient`, `radialGradient`), and drops any `data-dfai-…` the book
     writes itself, so it cannot pose as one the cleaning wrote;
   - the frame's builder refuses the same elements again and builds no handler,
     no `href` but `#` on a link or `#…`/`data:` on an SVG loader, and no file
     address that is not `data:`;
   - the frame's script stops every click (and `auxclick` and `submit`) and
     follows a link only by the `data-dfai-path` the cleaning wrote, by telling
     the reader;
   - neither the reader nor the frame's script calls a member through the
     document or a built node, where a book's name can shadow it (DOM
     clobbering: `<img name="createRange">` makes `document.createRange` that
     picture, and `<input name="appendChild">` does the same to its form). They
     call the DOM's own members, read off the prototypes as the script starts
     (`unshadowed-dom.ts`), on the node; and both the cleaning and the builder
     drop a `name` or `id` that would shadow a member of the document or a form
     on the elements that can (`img`, `form`, `embed`, `object`, `iframe` and
     the form controls). A `<p id="title">` or an `<a name="top">` shadows
     nothing and stays a link's target. Window names are not dropped: a
     window's own members are never shadowed by named elements;
   - a book's CSS is read by the browser's own parser, not by pattern: a
     constructed `CSSStyleSheet` that no document adopts (`replaceSync`, which
     fetches nothing and drops every `@import`). Its rules are walked, into
     `@media`, `@supports`, `@layer`, `@keyframes`, `@font-face` and nested
     rules, and each declaration's addresses are read with CSS's own
     tokenizing (`css-references.ts`: a `url()` quoted or bare, `src()`, and the
     strings of `image-set()`, `-webkit-image-set()`, `image()` and
     `cross-fade()`; comments, escapes and a backslash that joins two lines are
     read as CSS reads them). One of the book's files becomes its `data:`
     address, its `#place` kept; `data:` and a place in the chapter stay; a
     declaration naming anything else, or building an address from `var()`,
     `env()` or `attr()`, is dropped. Another rule naming an address
     (`@property`, `@counter-style`) is dropped whole. The sheet is written out
     as the parser serialises it. Each rule's declarations are then read again
     as the rule writes them out (`style.cssText`), shorthands and all, because
     WebKit writes a shorthand built with `var()` out as the book spelled it,
     every longhand empty: one that builds an address from `var()`, `env()` or
     `attr()`, or names one that may not stay, is dropped. Every custom
     property (`--*`) whose value holds a string, a `url()` or an address
     function is dropped, so no `var()` is ever handed an address. A `style=`
     is read the same way, as the declarations of one rule. The book's own
     `@import`s are the one thing still found by the reader's own scan, because
     the parser drops them: each is put before the sheet's rules, made the same
     way; a spelling the scan misses is an import the parser drops, never one
     that loads. The scan reads comments and strings as CSS does in one pass
     that never goes back. Each of the book's sheets is read and made once per
     open book, whether a chapter links it or a sheet imports it
     (`book-styles.ts`). Imports are bounded: a sheet is put in at most once in
     one sheet written out (the sheet being made counts as seen), and all of
     one chapter's CSS together, its `<link>`s and its `<style>`s' imports, puts
     in at most 64 of the book's sheets, 4 deep, and at most 4 MiB of them. The
     chapter's CSS is made one piece at a time in document order, so what a
     spent budget drops is the same however the book's files load;
   - the cleaning runs in the app's own window, so the work one sheet costs is
     bounded before it is read, and a book's CSS cannot freeze the app: a sheet
     (or `style=`) of more than 2 MiB, or nesting blocks more than 32 deep
     (WebKit's parser reads nested blocks in quadratic time), is dropped whole.
     The depth is read as CSS's tokenizer reads it: `(`, a function, `[` and
     `{` are closed only by their own closer, and strings, comments, escapes,
     numbers and an unquoted `url(`'s body (a bad one ends at its `)`) hold no
     blocks; where it differs from the tokenizer it counts deeper, never
     shallower, which a seeded property test against a tokenizer written to
     the spec holds it to; a rule listing more than 1,024 longhands has its declarations
     dropped (WebKit finds each by walking the rule's list); an `all` built
     from `var()` is dropped before its 445 longhands are read; and once 50,000
     longhands and rules have been read in a sheet, or 200,000 across one
     chapter's own `<style>`s and `style=`s, every further rule's declarations
     are dropped. A 2 MiB hostile sheet of any of these shapes shows its
     chapter in under 10 s in the e2e suite;
   - an attribute other than `style=` (an SVG presentation attribute such as
     `fill`, `mask`, `filter` or `cursor` is read as CSS) is read with the same
     tokenizing, and dropped if it names any address but a place in the
     chapter (`url(#id)`), or builds one from `var()`;
   - the frame's own policy runs no other script and loads nothing;
   - `index.html`'s `frame-src 'none'` is inherited by the frame as one more
     layer. A comment there and `index-html.test.ts` keep it, but nothing relies
     on it alone: the hostile e2e suite passes with it removed.

6. **A zip bomb is refused.** An EPUB is a ZIP, inflated in the app's own
   process, so the archive (`zip-loader.ts`) is refused as unreadable when it is
   opened if any file says it inflates past 64 MB, all of them past 512 MB, or a
   file of more than 1 MB says it inflates more than 100 times over (text
   deflates about five times, a bomb about a thousand). The sizes a ZIP says can
   lie, so each file is also refused, as unreadable, the moment it inflates past
   the size it said. Each file listed costs memory however empty it says it is,
   so an archive listing more than 10,000 files is refused too, by the count its
   central directory declares, before more than its first entry is read; zip.js
   makes exactly the entries that count declares. The directory's bytes are
   still read whole first, bounded only by the size of the archive. A long book
   with every picture has a few thousand.

7. **A long book is held a little at a time.** Each chapter's text is kept once
   read, for find and re-anchoring; only the three chapters parsed last are kept
   as documents, and another is parsed again when it is shown or a CFI in it is
   read. Find and re-anchoring read the book chapter by chapter with a message
   task between (`YieldToHost`), never one long task. Each stylesheet's rewritten
   CSS, and each file's address, is made once per open book.

## Consequences

- A book's HTML never runs, and could not reach the app if it did. The exploit
  above, and every other trick in the hostile fixture, is an e2e test in WebKit
  (`e2e/epub-reader.hostile.spec.ts`): no sentinel on the app's window, nothing
  fetched (a fake server for the book's site records no hit), the frame still
  `about:srcdoc`, the host never called — also with the cleaning bypassed by the
  test, and with `index.html`'s policy removed.
- The frame's script is a fixed string. Changing `frame-bootstrap.ts`,
  `text-positions.ts` or `unshadowed-dom.ts` means running `node tools/epub/frame-bootstrap.ts`; the
  unit test says so when it is forgotten.
- The reader no longer reaches into the frame, so the selection is what the
  frame last said, and the frame's copy of the chapter is DFAI's own build.
  CFIs are made and read on the reader's parsed chapter.
- A book's pictures and fonts are `data:` strings held for the open book: about
  a third larger than their bytes.
- The work budgets hold the reader to a generated 1,000-chapter, 30 MB book:
  open to the first chapter, turn a chapter, and find in the whole book.

## Alternatives rejected

- **Keep `allow-same-origin` and clean harder.** One missed attribute was enough
  once; a sanitiser cannot be the only wall between a book and the IPC.
- **foliate-js's own renderer.** It loads chapters from `blob:` addresses into a
  frame that needs `allow-scripts` and relies on a page-wide policy to hold a
  book's scripts back (ADR-0043's addendum).
- **Compute the hash at run time.** It would match whatever script was built,
  so nothing would hold the script to its reviewed source; a generated constant
  checked by a test does.
- **Send the chapter as markup for the frame to parse.** Parsing again in the
  frame invites a parser difference between the two sides (mutation XSS) and
  needs an HTML/XML round trip that some books do not survive; nodes as data are
  built exactly.
