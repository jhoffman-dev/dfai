/**
 * Reading a vault's rules (`loadAutomations`): it runs on every minute's tick
 * while a vault is open, so a vault with no rules must not cost a host call.
 */
import { describe, expect, it } from 'vitest';
import { automationVault, jsonNote } from '../testing/automation-vault.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import type { VaultFsPort } from '../vault/ports.ts';
import { loadAutomations } from './load-automations.ts';

/** The vault's files, with every batch `readNotes` was asked for. */
function countedReads(fs: VaultFsPort) {
  const asked: (readonly string[])[] = [];
  const counted: VaultFsPort = {
    ...fs,
    readNotes: (paths) => {
      asked.push(paths);
      return fs.readNotes(paths);
    },
  };
  return { fs: counted, asked };
}

const PARSER_REASON = 'Unexpected end of flow sequence at line 2, column 8';

/**
 * The real port's contract for a block that is not YAML: no properties, and
 * `frontmatterProblem` says why. Here a block that is not JSON is that block.
 */
function yamlFailing(markdown: MarkdownPort): MarkdownPort {
  const unreadable = (frontmatter: string | null) => {
    const inner = (frontmatter ?? '')
      .replace(/^---\n/, '')
      .replace(/---\n?$/, '')
      .trim();
    if (!inner.startsWith('{')) return false;
    try {
      JSON.parse(inner);
      return false;
    } catch {
      // Not JSON is what this fake calls malformed; the reason is the parser's below.
      return true;
    }
  };
  return {
    ...markdown,
    frontmatterProperties: (frontmatter, read) =>
      unreadable(frontmatter) ? {} : markdown.frontmatterProperties(frontmatter, read),
    frontmatterProblem: (frontmatter) => (unreadable(frontmatter) ? PARSER_REASON : null),
  };
}

describe('loadAutomations', () => {
  it('lists a rule file whose frontmatter cannot be read as broken, with the parser reason, and loads the rule beside it', async () => {
    const vault = automationVault({
      today: '2026-09-27',
      notes: {
        '.atlas/automations/Digest.md': '---\n{"atlas": "automation", "name": [\n---\n\nBody.\n',
        '.atlas/automations/Tidy.md': jsonNote({
          atlas: 'automation',
          name: 'Tidy',
          when: 'manually',
          which: 'FROM task',
          do: 'archive',
          enabled: true,
        }),
      },
    });
    const listing = await loadAutomations({
      fs: vault.ports.fs,
      markdown: yamlFailing(vault.ports.markdown),
      notePaths: vault.ports.notePaths,
    });
    expect(listing.automations.map(({ rule }) => rule.name)).toEqual(['Tidy']);
    expect(listing.broken).toEqual([
      {
        path: '.atlas/automations/Digest.md',
        name: 'Digest',
        problem: `Its frontmatter is not valid YAML: ${PARSER_REASON}`,
      },
    ]);
  });

  it('reads nothing from the vault when it has no rule files', async () => {
    const vault = automationVault({
      today: '2026-09-27',
      notes: { 'Areas/Garden.md': '# Garden\n' },
    });
    const { fs, asked } = countedReads(vault.ports.fs);
    const listing = await loadAutomations({
      fs,
      markdown: vault.ports.markdown,
      notePaths: vault.ports.notePaths,
    });
    expect(listing).toEqual({ automations: [], broken: [] });
    expect(asked).toEqual([]);
  });
});
