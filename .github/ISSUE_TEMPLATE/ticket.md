---
name: Ticket
about: A feature, fix or follow-up, with what it touches so it can be scheduled beside other work
title: ''
labels: ''
assignees: ''
---

<!-- What James wants, or what is wrong, and why it matters. -->

**What**

**Done when**

-

<!--
The three lists below decide what can be built in parallel (CLAUDE.md, "Running
tickets in parallel"). Fill them in before the ticket is picked up; write "none"
rather than leaving a list empty, so an empty list is never a guess.
-->

**Touches**

<!--
Shared use-cases and ports this ticket changes, by path or name
(e.g. packages/application/src/review/review-reads.ts, the SaveStore port).
Then tick every append-point file it edits.
-->

- Use-cases / ports:

Append points:

- [ ] `packages/shell/src/app.tsx`
- [ ] `apps/desktop/src/composition.ts` (and `apps/web/src/composition.ts`, which composes the same ports)
- [ ] `packages/shell/src/pages-on-first-use.ts`
- [ ] `packages/shell/src/styles/index.css` (a new stylesheet is imported here)
- [ ] `packages/application/src/api/routes.ts` and `contract.ts`
- [ ] `packages/application/src/index.ts` (or the `domain`, `adapters`, `ui` package `index.ts`)
- [ ] `packages/application/src/testing/query-index.ts`, `fake-reader.ts`, `api-fixture.ts`
- [ ] `apps/desktop/src-tauri/src/index.rs` (its view SQL and the hand-copied query SQL)
- [ ] `apps/mcp/src/server.ts`, `client.ts`, `main.test.ts`
- [ ] `vault/docs/api/v1.md`
- [ ] `docs/guide/src/page.html` (a new guide section is listed here; its text is a file in `docs/guide/src/sections/`)
- [ ] `tools/perf/budgets.json`, `budgets.spec.ts`, `budgeted-actions.ts`
- [ ] `e2e/host.ts`
- [ ] `COVERAGE.md`, `vitest.config.ts`
- [ ] a new ADR in `vault/docs/adr/` (takes the next number)

**Must land after**

<!-- Tickets or PRs that must merge first, e.g. "#120 (Inbox clarify): changes the Inbox rule these reads apply". -->

- none

**Must not run beside**

<!-- Tickets that touch the same use-case or port and so cannot be built at the same time. -->

- none
