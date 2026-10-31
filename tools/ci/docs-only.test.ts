import { describe, expect, it } from 'vitest';
import { isDocsOnlyChange } from './docs-only.ts';

describe('a docs-only change', () => {
  it.each([
    [['README.md']],
    [['CLAUDE.md', 'ENGINEERING.md', 'LICENSE']],
    [['docs/guide/index.html']],
    [['vault/docs/adr/0031-embeddings.md', 'vault/docs/design/tokens.md']],
    [['.claude/agents/coder.md']],
  ])('is one that touches only documentation: %j', (paths) => {
    expect(isDocsOnlyChange(paths)).toBe(true);
  });

  it.each([
    ['source', ['packages/domain/src/index.ts']],
    ['source beside docs', ['README.md', 'apps/desktop/src/app.tsx']],
    ['the workflow itself', ['.github/workflows/gate.yml']],
    ['a Markdown fixture the tests read', ['packages/domain/src/meetings/fixtures/valid/a.md']],
    ['a type file the tests read', ['vault/.atlas/types/task.md']],
    ['a note in the vault', ['vault/tasks/A15-03.md']],
    ['the API route table, which a test pins', ['vault/docs/api/v1.md']],
    ['the import contract', ['vault/docs/contracts/meeting-import-v1.schema.json']],
    ['a README inside a package', ['tools/n8n/README.md']],
    ['a file that only looks like the licence', ['apps/mcp/LICENSE']],
    ['a folder that only starts like docs', ['docs-tools/build.ts']],
    ['Claude settings beside the agents', ['.claude/settings.json']],
  ])('is not one that touches %s', (_what, paths) => {
    expect(isDocsOnlyChange(paths)).toBe(false);
  });

  it('is not an empty change, about which nothing is known', () => {
    expect(isDocsOnlyChange([])).toBe(false);
  });
});
