---
type: doc
status: current
date: 2026-10-20
---

# The design system

UI v2, "Dense & Calm", written down so later work stays in it. The target is
the mockups in `design/target/*.dc.html` (see `design/README.md`); the brief
is `docs/design/ui-v2-brief.md`, and the decision is
[[0041-dense-and-calm-hairlines-not-cards]]. This page is the vocabulary: the
tokens, the type scale, the pieces and the rules. If a surface needs something
that is not here, add it here first.

**As much on screen as possible, easy to scan.** Near-black text on white.
Colour is minimal and muted, in pastels. Corners are small. A 1px hairline
separates things, not a card or a shadow. Content runs edge to edge; the page
chrome is a few compact bars. Dark is the same on a warm near-black, not an
inversion and not a navy.

## The rules

The eight rules of the brief (§3), which the `Tokens` board also lists:

1. **No shadows on content.** A 1px hairline separates things.
2. **Colour is a pastel tint** on buttons, status pills, charts and the focus
   ring, never a filled area bigger than a button. No navy tiles, no
   gradients.
3. **One bold thing per row:** the title. Everything else is 400 weight in
   `--ink-2` or `--ink-3`.
4. **Metadata sits on one line**, separated by `·` (`P14 · Bug fixer · 1h`).
   No chip, icon or border per value.
5. **Hide empty values and zero counts.** Never print "Empty".
6. **Page chrome is compact.** No hero icon tile, no subtitle block, no
   floating rounded panel: content runs edge to edge on the surface.
7. **Board columns split the width equally**, empty or not. Columns and cards
   are square.
8. **Status is a tinted pill** in tables, peeks and filters. A board column's
   head uses the bare dot.

And the rules of the house, which v2 keeps:

- **Roles, never colours.** A component reads a token. A new colour is a new
  token, declared in light and in both dark blocks.
- **Internals stay off screen.** No `.atlas/`, no `.md`, no SQL, no raw
  markdown in a summary (`plainText`), no unlabelled value (`cardChips`).
- **One overlay at a time.** Only one is ever up
  (`packages/shell/src/overlay.ts`).
- **Judge it side by side.** `pnpm shots && pnpm design:compare`, both
  themes, before calling a surface done.

### The guards

`packages/shell/src/styles.test.ts` holds these rules over the whole
stylesheet, for good.

- **"the stylesheet"**: every token read is declared; a declared token is
  never papered over with a fallback; a raw colour (hex, `rgb()`, `hsl()`…)
  appears only in a block that declares tokens; light, dark and the system
  dark declare the same palette names.
- **"the v2 rules"**:
  - A shadow with a blur (or `--shadow-popover` / `--shadow-overlay`) only
    on what floats over the page — menus, popovers, palettes, the peek, link
    previews, toasts — or on what is in the hand while dragged (`--lifted`,
    `--held`, `.widget-ghost`). There are no exceptions today.
  - No `border-radius` above 8px, and no `--radius-pill`, except `50%` on
    a round mark: a dot, an avatar, a swatch, a spinner.
  - No `text-transform: uppercase`.
  - No `font-weight` above 600.

The last three each carry a named list of today's exceptions (19 radii, 5
capitals, 17 weights). A new offender fails, and so does one that was fixed
but is still listed, so the lists can only shrink. Fixing one changes what is
drawn, so each is a follow-up, not a cleanup.

Other `styles.*.test.ts` files hold one area each: the pill hues' contrast
(`styles.pill-hues.test.ts`), the toasts, the notices, the palettes, and so
on.

## Tokens

All in `packages/shell/src/styles/tokens.css`. Light is `:root` and
`[data-theme='light']`; dark is `[data-theme='dark']` and the
`prefers-color-scheme: dark` block. The explicit selectors are not anchored to
`:root`, so a subtree can carry a theme of its own (the primitives gallery
shows both).

The v2 names below are the primitives. The older role names (`--ground`,
`--panel`, `--raised`, `--accent`, `--chip`…) are declared once more at the
end of the file as aliases of them, for the components that still read them.
New code reads the v2 names.

### Palette

| Token           | Light     | Dark      | For                                          |
| --------------- | --------- | --------- | -------------------------------------------- |
| `--bg`          | `#f6f6f7` | `#111113` | The left sidebar, the tab strip, board wells |
| `--surface`     | `#ffffff` | `#18181b` | Content, cards, the right sidebar            |
| `--well`        | `#f8f8f9` | `#1d1d21` | A table's group row, a notice bar            |
| `--ink`         | `#18181b` | `#ededef` | Primary text                                 |
| `--ink-2`       | `#52525b` | `#b4b4bc` | Secondary text, controls                     |
| `--ink-3`       | `#6b6b73` | `#8e8e98` | Metadata and labels (≥ 4.5:1)                |
| `--line`        | `#e6e6e9` | `#2a2a2f` | Hairlines, a card's border                   |
| `--line-soft`   | `#ececef` | `#2a2a2f` | A table's row dividers                       |
| `--line-strong` | `#d9d9de` | `#3a3a40` | A control's border                           |
| `--hover`       | `#f4f4f6` | `#222227` | A row or button under the pointer            |
| `--selected`    | `#e8e8eb` | `#26262b` | The active nav item, a pressed toggle        |
| `--focus`       | `#6b7bc4` | `#8f9be0` | The focus ring and the editing cell's ring   |
| `--sep`         | `#c4c4ca` | `#4a4a52` | The `·` between metadata                     |

Charts read `--chart-grid`, `--chart-bar` and `--chart-bar-ink`; code reads
`--code-bg` and the `--code-*` syntax hues, the one place more than one hue
earns its keep. `--artifact-canvas` is white in both themes, because a saved
page made elsewhere assumes it. `--star` is the favourite star.

### Status

Eight statuses, each with a dot, a pill ink and a pill tint:
`--status-<tone>-dot`, `-ink`, `-tint` for `inbox`, `backlog`, `next`,
`doing`, `waiting`, `review` and `done`. Someday and Longterm are drawn in
Backlog's grey and Archive in Done's green; every status keeps its own label.

- The dots alone do not separate for everyone, so a status always shows its
  label. Never colour alone.
- A dot is drawn bare on a board column's head, so each light dot holds 3:1
  against the surface and the bg. That made them a little deeper than the
  brief's pastels.
- In dark the dots are the brief's pastels, the inks lighten, and a tint is
  the dot at 14–16% alpha.

### Hues: pills that help the eye find a value

A select option that is not a status, a linked note and a tag are pills in
one of nine muted hues (`--hue-<name>-bg`, `--hue-<name>-ink`): gray, brown,
orange, yellow, green, blue, purple, pink and red. The fills are solid, not
tints, so they read the same on every surface. Each ink holds 4.5:1 on its
fill (`styles.pill-hues.test.ts`). In dark the fill is deep and the pastel is
the ink.

A pill takes its paint from `data-hue` (a hue) or `data-tone` (a status),
chosen by `pillPaint` in `packages/ui`. **Chrome never carries a hue**: bars,
tabs, menus and buttons stay neutral, and colour belongs to the values.

### Buttons

Five kinds, each a fill, an ink and a line (`--btn-<kind>-bg`, `-ink`,
`-line`):

| Kind        | Light                          | For                                 |
| ----------- | ------------------------------ | ----------------------------------- |
| Primary     | pastel blue, no border         | The one thing to do, a view's "New" |
| Positive    | pastel green, a green hairline | Accept, confirm, Done               |
| Destructive | pastel rose, a rose hairline   | Reject, delete                      |
| Secondary   | white with a hairline          | Neutral actions                     |
| Ghost       | bare, `--ink-2`                | Everything else                     |

In dark each tint is its hue at 16–18% alpha with a lightened ink. Accept and
Reject must look different: that is why positive and destructive exist.

`--danger`, `--warning` and `--success` say what happened, in the same inks
the buttons and pills use. Never decoration.

### Depth

Only what floats casts a shadow.

| Token              | For                                                        |
| ------------------ | ---------------------------------------------------------- |
| `--shadow-popover` | Menus, popovers, palettes, link previews, toasts           |
| `--shadow-peek`    | The center peek                                            |
| `--scrim`          | The backdrop behind a palette or a dialog                  |
| `--scrim-peek`     | The heavier backdrop behind the peek (ink at 30% in light) |

In dark each shadow carries a faint 1px ring, because a shadow alone does not
read on a dark surface. The older `--shadow-card`, `--shadow-tile` and
`--shadow-soft` are a 1px hairline ring, not a shadow; `--shadow-panel` and
`--shadow-accent` are `none`. `--ring` is the focus ring: a 2px gap in the
surface colour, then 2px of `--focus`.

### Radius

`--radius-chip` 4 (chips and pills) · `--radius-control` and
`--radius-button` 6 (buttons, fields) · `--radius-popover` 8 (popovers, menus,
the peek, toasts) · `--radius-row` 5 (a sidebar row) · `--radius-card` and
`--radius-panel` 0: the panel, cards and board columns are square. Only dots
and avatars are fully round, at `50%`. `--radius-pill` (999px) is still read
by a few pill shapes; they are on the guard's list of exceptions.

### Space

`--space-1` to `--space-7`: 4, 8, 12, 16, 20, 24 and 32px.

### Type

The system stack (`--font-ui`: `-apple-system`, `SF Pro Text`, `Segoe UI`,
`system-ui`); nothing is bundled or fetched. `--font-mono` is `ui-monospace`.
Weights 400, 500 and 600 only. Numbers in tabular figures.

| Token               | Size | For                                              |
| ------------------- | ---- | ------------------------------------------------ |
| `--text-note-title` | 24   | A note's title: 600, `--tracking-title`          |
| `--text-section`    | 15   | A section title: 600                             |
| `--text-body-lg`    | 14   | Running text meant to be read                    |
| `--text-emphasis`   | 13   | A card's title, the active tab: 500              |
| `--text-body`       | 13   | Body, table rows, nav: 400                       |
| `--text-column`     | 12.5 | Column and group labels: 600                     |
| `--text-code`       | 12.5 | Inline code                                      |
| `--text-meta`       | 12   | Metadata, in `--ink-3`                           |
| `--text-mono`       | 12   | Ids and code blocks                              |
| `--text-header`     | 11.5 | Section and column headers: 500, `--ink-3`; keys |

The older names (`--text-label`, `--text-small`, `--text-ui`, `--text-card`,
`--text-subtitle`) are aliases of these. Capitals are never set by CSS; a
label is written in sentence case. Monospace is for ids, code and things that
are literally code, never for a title or a label.

### Sizes

| Element                    | Size                                                   |
| -------------------------- | ------------------------------------------------------ |
| Left sidebar               | 224px (`--sidebar-width`), rows 28px (`--sidebar-row`) |
| Right sidebar              | 300px; 340px for the type editor (`--aside-width`)     |
| Tab strip                  | 36px                                                   |
| Nav bar                    | 40px                                                   |
| View bar                   | 44px, on a typed view only                             |
| Table header and group row | 32px                                                   |
| Table row                  | 34px                                                   |
| Control, field             | 28px                                                   |
| Chip, pill                 | 20px                                                   |
| A note's reading width     | 720px, centred                                         |

## Primitives

The shared pieces are in `packages/shell/src/styles/primitives.css`; the
components that draw them are in `packages/ui/src`. One kind of thing is
drawn one way.

- **Buttons** — `.btn` with `--primary`, `--positive`, `--destructive`,
  `--secondary` or `--ghost`. 28px, radius 6. Every kind carries a border,
  transparent where it has none, so they all measure the same. Hover mixes a
  little ink into the fill. `.btn--sm` is 22px, for inside a row or a band.
  One primary per view.
- **Fields** — `.field`: a 28px box on the surface, a `--line-strong`
  hairline, radius 6, the focus ring while written in. `.field--block` grows
  with its lines; `.field--invalid` says it is wrong. `.select` wraps a
  `select` and draws its chevron.
- **Segmented control and switch** — `.segmented`: a well as the track, the
  chosen option lifted onto it (`--quiet` for a preference, with square
  options). `.toggle`: a knob on a track, whose position as well as colour
  says it is on.
- **Chips** — `.chip`: 20px, radius 4, 12px text, no icon; a value's kind is
  said by its words. `--accent` and `--danger` tint it.
- **Status pill and dot** — `StatusPill` and `.status-pill`: a 20px pill on
  its tint with a 6px dot and the label, in a table's cell, a filter and the
  peek's strip. `.status-pill--dot` is the bare 8px dot, for a board column's
  head. `TintedPill` draws a hue's pill the same way.
- **Notice bar** — `.notice-bar`: one line on the well under a hairline, at
  least 40px, its icon in `--ink-3`, its words in `--ink`, its actions at the
  right end (the first secondary, the rest ghost). An offer the Inbox makes,
  the band over a template, the saved-view controls: each is this bar, never a
  card. A long warning wraps and the bar grows.
- **Menus** — `.menu` (Base UI): a popover on the surface with a hairline,
  radius 8 and `--shadow-popover`. Rows are 28px of body text; the highlighted
  one takes `--hover`; a shortcut is plain metadata at the right. The
  editor's slash menu and `[[` suggestions are the same.
- **Palettes** — the search (⌘K) and capture (⇧⌘N) palettes and Settings:
  the same popover over `--scrim`, with 36px rows and the `--selected`
  highlight.
- **Keys** — `Key` and `KeyHints`: a key or chord (`⌘K`, `↵`, `esc`) is
  plain 11.5px `--ink-3` text, with no box. An overlay lists the keys it
  answers to along its foot, one 34px line above a hairline.
- **Toast** — `Toast`: one line that something happened, on a dark surface
  in both themes (`--toast-*`), with a dot in a muted hue (a change, a
  warning, an error), the words, Undo for a change, an action of the caller's
  ("Open"), and a ×. It goes after 5 s (`TOAST_MS`) and waits while the
  pointer or the focus is on it; an error stays until it is sent away. It
  never takes the focus.
- **ToastStack** — the window's toasts in one column, oldest on top, at most
  three (`MAX_TOASTS`), each with its own time. It sits at the bottom right,
  12px in and 92px up, where the retired add button rested; the top right is
  the pane's bars and their controls. It sits under menus, palettes, dialogs
  and the peek (z-index 21), so it hides none of their controls; while the
  peek is up it is drawn inside the peek (`.peek__toasts`), in its focus
  trap. A refused Undo is a warning toast; an answer's own failure with
  nothing to take back stays on its section or under the page bar instead.
- **Spinner** — `.spinner`: shown only once loading has taken 150 ms
  (`SPINNER_DELAY_MS`), held invisible until then by the stylesheet. No
  words, no skeleton, and its block holds its place from the start.

## The shell

Left sidebar | panes | right sidebar. When the window runs out of room the
right sidebar collapses first (`packages/ui/src/aside/collapse.ts`); the left
sidebar never folds by width, because the window is never narrower than
720px.

- **Left sidebar** (`Sidebar.dc.html`) — on `--bg`, 224px, rows 28px. The
  vault, then the fixed places, then Dashboards, Favorites, Views and Types,
  and the Pages tree last. Settings, sync and the theme toggle at the foot.
  The active row takes `--selected`. Counts are `--ink-3` and hidden at 0.
  ⌘\\ hides it.
- **Tab strip** — `TabStrip`, `styles/tabs.css`: 36px on `--bg` over a
  hairline. Square tabs, 176px shrinking to 120px, then the list scrolls; a ×
  on the tab and a + after the tabs. The shown tab sits on the surface and
  breaks the hairline; its 2px top border is ink in the focused pane and grey
  in the other. Each pane has its own tabs; each tab its own back/forward and
  undo history. The model is `docs/design/tab-model.md`.
- **Nav bar** — 40px: ← → for the tab's history, the breadcrumb, then the
  view's buttons, Saved, ☆, ⋯ and the right-sidebar toggle.
- **View bar** — 44px, only on a typed view (`ViewToolbar`): its sibling
  views as tabs, Filter and Sort, and the one primary "New …".
- **Right sidebar** — `RightSidebar`, `styles/aside.css`: on the surface,
  behind a hairline. Its tabs are Type, Properties, Backlinks, Outline and
  Claude (the chat); only the ones that have something to show are offered.
  300px, 340px for the type editor. ⌥⌘\\ and the nav bar's toggle show and
  hide it, and its state is remembered. Hidden, a note's properties collapse
  to one metadata line under its title.
- **Center peek** — `PeekDialog`, `styles/peek.css`: an 840px dialog, radius
  8, `--shadow-peek`, over `--scrim-peek`. A 44px header (↑ ↓ and "3 of 186
  in Task table", Saved, Open as full page, Open in new tab, Open in split,
  ×), the title, a one-line
  `PropertiesStrip` with "+ N empty", the editable body, and a 34px foot of
  key hints. The chrome stays neutral; colour is in the strip's values.
- **Link preview** — `LinkPreviewCard`: a popover after the pointer rests
  400 ms on a wikilink or a relation value (`LINK_PREVIEW_DELAY_MS`): the
  title, type and phase, and up to four lines of the note.
