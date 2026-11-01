---
type: adr
id: ADR-0041
title: Dense and calm — hairlines, not cards
status: accepted
date: 2026-10-20
---

# ADR-0041 — Dense and calm: hairlines, not cards

## Context

The Phase 16 look (the old `system.md`) was built from floating rounded
panels with shadows, near-white raised cards with 16–24px radii, big navy
icon tiles, one navy hero gradient, 800-weight titles, a filled pill on every
chip and tab, and a page header about 200px tall.

The maintainer found it busy, and wasteful of the screen. The brief
(`docs/design/ui-v2-brief.md`, approved 2026-10-17) asks for as much
information on screen as possible, well organised and easy to scan: high
contrast, minimal muted colour in pastels, small radii, and hairlines instead
of cards. It also asks for the behaviour the first build had to guess at:
how a note is opened, tabs, the right sidebar, editing in place, link
previews, feedback, and the Inbox.

The mockups are `design/target/*.dc.html`. The `Tokens` board holds the
tokens, sizes and the rules list. Where the brief and a mockup disagree, the
mockup wins on look and the brief wins on behaviour. The plan,
`docs/design/ui-v2-plan.md`, cut the work into slices 0 to 15 under epic
#267, and its §4 put 22 open questions to the maintainer.

## Decision

1. **Hairlines, not cards.** A 1px `--line` separates things. Nothing on
   content casts a shadow. Content runs edge to edge on the surface, with no
   floating panel and no gutter. Cards and board columns are square.
2. **Tokens.** Two near-neutral palettes: white content beside a pale grey
   sidebar, and the same on a warm near-black in dark. Eight status tones,
   each a dot, an ink and a tint. Five button kinds, with Accept (positive,
   green) and Reject (destructive, rose) made distinct. Nine muted hues for
   pills that only help the eye (#413), with neutral chrome. Radius 4 for
   chips and pills, 6 for buttons and fields, 8 for popovers, menus, the
   peek and toasts, 0 for cards and panels; fully round only for dots and
   avatars. The system font stack, replacing the bundled Manrope, at weights
   400, 500 and 600. Shadows only on what floats. All of it is in
   `packages/shell/src/styles/tokens.css`, and `vault/docs/design/system.md`
   is the reference.
3. **The eight rules** of the brief (§3), also on the `Tokens` board: no
   shadows on content; colour as pastel tints only, never a filled area
   bigger than a button, no navy tiles or gradients; one bold thing per row;
   metadata on one line separated by `·`; hide empty values and zero counts;
   compact page chrome with no hero tile or subtitle; board columns of equal
   width, square; status as a tinted pill, the bare dot on a board column's
   head.
4. **The rules are guards.** `packages/shell/src/styles.test.ts` ("the v2
   rules") fails on a blurred shadow outside what floats over the page or is
   being dragged, on a radius above 8px other than a round mark's 50%, on CSS
   capitals, and on a weight above 600. What breaks a rule today is named in
   the test, and the lists may only shrink.
5. **The shell.** Left sidebar, panes, right sidebar. Each pane has a 36px
   tab strip and a 40px nav bar. The 44px view bar shows only on a typed
   view (Q1). The right sidebar collapses first when room runs out.
6. **The peek.** A click on a note or a task opens a center peek, a modal
   over the view. ⌘-click opens a new tab and ⌘⇧-click a split; from the
   peek, ⌘↵ and ⌘⇧↵ do the same, and expand replaces the tab. There is no
   side-peek. Hovering a link for 400 ms shows a preview card.
7. **Tabs.** Every pane has its own tabs; splits are panes. Each tab keeps
   its own back/forward and undo/redo history, like a browser tab, and tabs
   come back on restart. The model is `docs/design/tab-model.md`.
8. **The aside.** The right sidebar is contextual: Properties, Backlinks,
   Outline, the type editor, and the chat. When it is hidden, a note's
   properties collapse to one line under its title. Its open state is
   remembered.
9. **Feedback.** A toast for any change offers Undo and leaves after 5 s.
   Warnings and errors also go to Activity. Loading shows a spinner only
   after 150 ms.

The answers to the plan's §4 questions, as recorded on #267 (the
2026-10-17 answers in the issue body and the first approval comment; the
rest in the approval of 2026-10-18, which took every remaining
recommendation in §4 as the answer):

- **Q1** — A tab strip plus a 40px nav bar on every pane. The 44px view bar
  shows only on a typed view (the sibling-view tabs of ADR-0023).
- **Q2** — ⌘\\ keeps hiding the left sidebar; ⌥⌘\\ toggles the right sidebar.
- **Q3** — Eight statuses. Someday and Longterm use the Backlog grey; Archive
  is drawn in Done's green. Every status keeps its own label. The picker's
  number keys run 1–8.
- **Q4** — The chat becomes a fourth tab, "Claude", of the right sidebar. ⌘J
  opens the aside on that tab. The chat keeps its own component and store.
- **Q5** — The floating add button is retired. Its two jobs are covered: a
  new task comes from the view's one primary "New task", and a capture from
  ⇧⌘N. Alt+⌘N is kept and opens the capture palette, so nothing a hand knows
  stops working. Its code went in slice 15.
- **Q6** — ↑/↓ step rows only while focus is on the peek's chrome; in the
  body they move the caret. ⌥↑/⌥↓ step rows from anywhere in the peek. The
  peek is modal to the note-making shortcuts (⌘N, ⇧⌘N, Alt+⌘N) and to the
  split and close-pane shortcuts, but not to ⌘K: search opens above it, and
  picking a result replaces the peeked note.
- **Q7** — Inactive tabs' editors stay mounted and hidden, at most four per
  pane; beyond that the least recently shown unmounts and its undo history
  resets. A hidden editor's autosave pauses, and it flushes on switch-away.
- **Q8** — Every page that used to replace the panes is a kind of place a
  tab holds, and `MainView` is retired. A page opened from the sidebar
  replaces the active tab's place; ⌘-click opens it in a new tab.
- **Q9** — Only how the existing dashboard widget kinds are drawn changes.
  The table toggle is per widget and is not saved.
- **Q10** — `required` is a new optional key on a type's property. It
  prompts on a new note rather than blocking it. "Allow many" is the
  existing many-relation and multi-select flag under a new label. The mono
  path of the type file is not shown.
- **Q11** — In the Inbox, N, W, S and D write the status alone. P picks a
  project. T sets a defer date (`start`), not a timeblock. Longterm has no
  key. "Not now" dismisses a notice for the session.
- **Q12** — Two proposals conflict when they share kind, source and slot but
  differ in value. The same value is a duplicate, shown once. The rule is
  `conflictGroups` in the domain, and nothing about it is stored.
- **Q13** — A single sun/moon toggle, plus "Match system" in Settings.
- **Q14** — The mockups moved from `design/v2` to `design/target`; the Phase
  16 boards were deleted (git history keeps them).
- **Q15** — Denser rows must not raise a work budget. Draw fewer off-screen
  rows to hold the counts. Any rise needs the maintainer first.
- **Q16** — Notes keep the centred 720px reading width.
- **Q17** — The dark button values are as the plan proposed in §1.
- **Q18** — The right sidebar has fixed widths, 300px and 340px for the type
  editor, behind an `--aside-width` token.
- **Q19** — The saved-view controls (Save / Save as new / Reset) sit in a
  well-coloured notice bar under the nav bar, like the Inbox's.
- **Q20** — The Pages tree stays as the last section of the sidebar,
  restyled.
- **Q21** — ⌘T opens a new tab, ⌘W closes the active tab (and the pane on a
  split pane's last tab; never the window), ⌃Tab and ⌃⇧Tab cycle tabs, and
  ⌘1–⌘8 jump to a tab, ⌘9 to the last. ⌘[ and ⌘] stay the tab's history.
- **Q22** — Link previews show on wikilinks and on relation values, but not
  on sidebar rows or board cards.

Slice 15 also moved the proposals notice and the Make-task notice off their
20-second undo bars and onto the window's toast with Undo, and deleted
`UNDO_BAR_MS`. An answer's or a promotion's own failure, with nothing to
take back, stays on its section or under the page bar until it is
dismissed; a refused Undo is a warning toast, said wherever the person is.

The toasts sit under every layer a person works in — menus (z 30),
palettes, dialogs and the peek (z 40) — so they never hide one of its
controls. While the peek is up they are drawn inside it instead, in a place
it hands over after its header: in its focus trap, so Tab reaches an Undo,
and still at the window's corner. Their buttons say `tabindex="0"`, since
WebKit, and so the app's webview, Tabs to no button that does not.

## Consequences

- The app shows more on one screen, and colour now means a value: a status,
  a hue, a button's kind. Chrome is neutral.
- The older role tokens (`--ground`, `--panel`, `--raised`, `--accent`…) are
  aliases of the v2 names, so a component that reads one still draws in v2.
- Today's exceptions to the guards are follow-ups: 19 selectors rounder than
  8px (pill shapes, the switch, the selection bar…), 5 that set capitals by
  CSS, and 17 heavier than 600. They are listed in `styles.test.ts`. Each
  one fixed changes what is drawn, so each needs its own look in
  `pnpm shots`, and is then taken off its list.
- The retired add button left room at the window's foot, and that room is
  kept as it was: the toasts sit 24 + 56 + 12px up from the bottom right
  (`.toast`, `.toast-stack`), the table keeps a 56px row of room under its
  last row (`table.css`), and the Inbox keeps 96px of padding at its foot
  (`inbox.css`). Changing any of them moves what is on screen, so it is a
  separate decision.
- Toasts sit at the bottom right, not the top right the brief drew. The top
  right is the pane's bars and their controls (the star and the menu, the
  view bar's "New"), and a toast there covered one for 5 s.
- The light status dots are a little deeper than the brief's pastels, so a
  bare dot holds 3:1 against the surface and the bg (#328).

## Alternatives considered

- **Restyle Phase 16 in place.** Keeping the cards and the panel and only
  toning them down would keep the space they take, which is the complaint.
- **A component kit.** A kit brings its own look, which would then have to
  be undone to reach this one. ADR-0015 already rejected a kit for that
  reason; the hard parts stay Base UI, styled from one primitives file.
- **Keep the floating add button, restyled** (the plan's other option for
  Q5). Its jobs are covered by the view's "New task" and by ⇧⌘N, and no
  mockup draws it.
- **A side-peek.** Considered in the brief and dropped, with columns in the
  note editor.
