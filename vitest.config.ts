import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { startTemporaryFolderPerRun } from './tools/temp-folder-per-run.ts';

// Vitest makes a folder of its own in the temp folder as it starts, before any
// global set-up runs, and never removes it (#486), so the run's folder starts here.
startTemporaryFolderPerRun();

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // A list, so one entry can match exactly; string entries also claim every
    // path below them, so a subpath comes before the package it is under.
    alias: [
      // Before '@dfai/ui', which would otherwise claim it as a path inside its index file.
      // A second entry point so the graph page, loaded lazily, keeps d3-force out of
      // the main bundle: the barrel is imported eagerly and everything it exports lands there.
      {
        find: '@dfai/ui/graph',
        replacement: fileURLToPath(new URL('./packages/ui/src/graph/index.ts', import.meta.url)),
      },
      // Test support (the render counter), kept out of the barrel the app is built from.
      // Exact, so it does not claim `@dfai/ui/testing/settles` below.
      {
        find: /^@dfai\/ui\/testing$/,
        replacement: fileURLToPath(new URL('./packages/ui/src/testing/index.ts', import.meta.url)),
      },
      // Test support of its own entry point (see packages/ui/src/testing/index.ts).
      {
        find: '@dfai/ui/testing/settles',
        replacement: fileURLToPath(
          new URL('./packages/ui/src/testing/settles.ts', import.meta.url),
        ),
      },
      // Before '@dfai/application', for the same reason: test support that needs
      // node:sqlite, kept out of the barrel the app's browser bundle is built from.
      {
        find: '@dfai/application/testing/sqlite',
        replacement: fileURLToPath(
          new URL('./packages/application/src/testing/sqlite.ts', import.meta.url),
        ),
      },
      // Test support (work counted rather than timed), kept out of the domain's barrel.
      {
        find: '@dfai/domain/testing',
        replacement: fileURLToPath(
          new URL('./packages/domain/src/testing/index.ts', import.meta.url),
        ),
      },
      { find: '@dfai/domain', replacement: pkg('domain') },
      { find: '@dfai/application', replacement: pkg('application') },
      // The PDF reader's adapter, an entry of its own so pdf.js stays out of the start-up bundle.
      {
        find: '@dfai/adapters/pdf',
        replacement: fileURLToPath(
          new URL('./packages/adapters/src/pdf/index.ts', import.meta.url),
        ),
      },
      // The EPUB reader's adapter, an entry of its own so foliate-js stays out of the start-up bundle.
      {
        find: '@dfai/adapters/epub',
        replacement: fileURLToPath(
          new URL('./packages/adapters/src/epub/index.ts', import.meta.url),
        ),
      },
      { find: '@dfai/adapters', replacement: pkg('adapters') },
      { find: '@dfai/ui', replacement: pkg('ui') },
    ],
  },
  test: {
    globals: true,
    // Node by default; component tests opt in with `// @vitest-environment jsdom`.
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    // A temp folder of the run's own, removed when it ends (issue #397).
    globalSetup: ['./tools/temp-folder-per-run.ts'],
    include: [
      'packages/*/src/**/*.test.{ts,tsx}',
      'apps/*/src/**/*.test.{ts,tsx}',
      'tools/**/*.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html', 'lcov'],
      include: [
        'packages/*/src/**/*.{ts,tsx}',
        'apps/*/src/**/*.{ts,tsx}',
        'tools/n8n/*.ts',
        'tools/notion-import/*.ts',
        'tools/release/*.ts',
      ],
      exclude: ['**/*.test.{ts,tsx}', '**/index.ts', '**/*.d.ts'],
      // Repo-wide floor. The high-impact slice named in COVERAGE.md is held higher,
      // with its own threshold added as each module lands.
      thresholds: {
        lines: 70,
        'packages/domain/src/**': { lines: 90, functions: 90, branches: 85 },
        // A refresh writes files into the vault, so it is held to the same bar
        // as the rules it carries out.
        'packages/application/src/sources/**': { lines: 90, functions: 90, branches: 85 },
        // Editing a type rewrites its file, and can rewrite every note of it; setting a
        // vault up for PARA writes type files and adds to the vault's own (P30-01).
        'packages/application/src/types/{edit-types,migrate-notes,load-types,ensure-built-in-types}.ts':
          {
            lines: 90,
            functions: 90,
            branches: 85,
          },
        // The local API writes into the vault on behalf of other programs.
        'packages/application/src/api/**': { lines: 90, functions: 90, branches: 85 },
        // Renaming a tag rewrites every note that uses it.
        'packages/application/src/tags/**': { lines: 90, functions: 90, branches: 85 },
        // Saving an artifact writes a folder of files into the vault.
        'packages/application/src/artifacts/**': { lines: 90, functions: 90, branches: 85 },
        // Archiving moves notes and rewrites their frontmatter (U-22).
        'packages/application/src/archive/**': { lines: 90, functions: 90, branches: 85 },
        // Processing the Inbox moves notes and rewrites their frontmatter (P30-01).
        'packages/application/src/inbox/**': { lines: 90, functions: 90, branches: 85 },
        // Moving tasks to GTD rewrites every task, view and rule naming a status, and undoes it (P30-02).
        'packages/application/src/gtd/**': { lines: 90, functions: 90, branches: 85 },
        // Accepting a proposal writes notes and archives it; undo takes them back (P29-02).
        'packages/application/src/proposals/**': { lines: 90, functions: 90, branches: 85 },
        // Writes highlights into, and takes them out of, a literature note in the vault (#503).
        'packages/application/src/highlights/**': { lines: 90, functions: 90, branches: 85 },
        // Reads every source and highlight for the research views; a wrong read hides them (#507).
        'packages/application/src/research/**': { lines: 90, functions: 90, branches: 85 },
        // Answers what Claude is told about a person, a project or a meeting, every item cited (#35).
        'packages/application/src/assistant/**': { lines: 90, functions: 90, branches: 85 },
        // Copies a PDF or an EPUB into the vault and makes its literature note; writes the readers' highlights (#504, #505).
        'packages/application/src/reader/**': { lines: 90, functions: 90, branches: 85 },
        // What stands between an untrusted book and the app: the cleaning, what the frame is
        // handed and builds, and every message between them (#505, ADR-0045).
        'packages/adapters/src/epub/{chapter-safety,chapter-source,frame-bootstrap,frame-protocol,text-positions}.ts':
          { lines: 90, functions: 90, branches: 85 },
        // A task's schedule is read from the index and answered to the API (P31-01);
        // a drop on the calendar writes a block or links a task into one, and undoes it (P31-02).
        'packages/application/src/timeblocks/**': { lines: 90, functions: 90, branches: 85 },
        // An automation moves and rewrites notes by itself, on a clock (P25).
        'packages/application/src/automations/**': { lines: 90, functions: 90, branches: 85 },
        // A sync merges other Macs' changes into the notes and settles conflicts (U-29).
        'packages/application/src/sync/**': { lines: 90, functions: 90, branches: 85 },
        // Meeting import marks, and archives, files that arrived from outside DFAI (P28-04).
        'packages/application/src/meetings/**': { lines: 90, functions: 90, branches: 85 },
        // Linking a meeting writes its people and companies, and proposals, by itself (P29-04).
        'packages/application/src/meeting-links/**': { lines: 90, functions: 90, branches: 85 },
        // Who the vault's owner is — their name and addresses — decides whose a meeting's tasks are (#173).
        'packages/application/src/profile/**': { lines: 90, functions: 90, branches: 85 },
        // Kept work is the only copy of typing the vault never got.
        'apps/desktop/src/notes/*stranded*.ts': { lines: 90, functions: 90, branches: 85 },
        // Carries the API token, and turns every failure into what the model is told.
        'apps/mcp/src/{connection,client}.ts': { lines: 90, functions: 90, branches: 85 },
        // n8n's workflow builder and its GitHub checks decide what is committed into the vault (P28-02);
        // the mapper they compile in is the domain's, held to the domain's bar (#93).
        'tools/n8n/*.ts': { lines: 90, functions: 90, branches: 85 },
        // Adding a term writes a note; editing one rewrites its frontmatter (P28-05).
        'packages/application/src/terms/**': { lines: 90, functions: 90, branches: 85 },
        // The Notion meeting import writes a history of meetings into a vault (P28-07).
        'tools/notion-import/*.ts': { lines: 90, functions: 90, branches: 85 },
        // Writes the version into every manifest, and is the check a release trusts (#481).
        'tools/release/*.ts': { lines: 90, functions: 90, branches: 85 },
        // Connects Google Calendar and reads Google's answers (P31-03). The tokens
        // themselves never reach TypeScript; their handling is the host's, tested in Rust.
        'packages/{application,adapters}/src/google-calendar/**': {
          lines: 90,
          functions: 90,
          branches: 85,
        },
        // Pulls Granola's notes and writes them into the vault by itself, and reads a third
        // party's answers into the app's types (P28-11). The key is the host's, tested in Rust.
        'packages/{application,adapters}/src/granola/**': {
          lines: 90,
          functions: 90,
          branches: 85,
        },
        // Reads Amazon's Kindle notebook into highlights to write into source notes,
        // by itself (#508). The session's cookies are the host's, tested in Rust.
        'packages/{application,adapters}/src/kindle/**': {
          lines: 90,
          functions: 90,
          branches: 85,
        },
      },
    },
  },
});
