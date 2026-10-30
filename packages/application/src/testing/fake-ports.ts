import { KeyAsWritten } from '@dfai/domain';
import type { OpenNotes } from '../api/ports.ts';
import type { IndexPort } from '../index/ports.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import type { HostVaultFsPort, VaultFsPort } from '../vault/ports.ts';

/**
 * A vault that does nothing, for tests that care about one method.
 *
 * Every test used to spell out all of a port's methods, so adding one to the port
 * meant editing every fake in the repo. Overriding what a test cares about keeps
 * the test about its subject.
 */
export function fakeVaultFs(overrides: Partial<VaultFsPort> = {}): VaultFsPort {
  return {
    listDirectory: async () => [],
    listNotes: async () => [],
    listFiles: async () => [],
    readNotes: async () => [],
    readBinaryFile: async () => new ArrayBuffer(0),
    readTextFile: async () => ({ text: '', modified: 0 }),
    createNote: async () => 0,
    createFolder: async () => {},
    moveEntry: async () => {},
    trashEntry: async () => {},
    writeTextFile: async () => 0,
    writeBinaryFile: async ({ bytes, offset }) => offset + bytes.byteLength,
    ...overrides,
  };
}

/** The host's file commands, before they are bound to a vault: each write names one. */
export function fakeHostVaultFs(overrides: Partial<HostVaultFsPort> = {}): HostVaultFsPort {
  return { ...fakeVaultFs(), ...overrides };
}

export function fakeIndexPort(overrides: Partial<IndexPort> = {}): IndexPort {
  return {
    open: async () => ({ fresh: false }),
    clear: async () => {},
    manifest: async () => [],
    put: async () => {},
    remove: async () => {},
    search: async () => [],
    notesOfType: async () => [],
    rebuildViews: async () => {},
    query: async () => ({ columns: [], rows: [], truncated: false }),
    backlinks: async () => [],
    stats: async () => ({ notes: 0, properties: 0, links: 0 }),
    ...overrides,
  };
}

/** Frontmatter lines of the form `key: value`, as plain values. */
function frontmatterLines(frontmatter: string | null): Map<string, string> {
  return new Map(
    (frontmatter ?? '')
      .split('\n')
      .map((line) => /^(\w+):\s*(.*)$/.exec(line))
      .filter((found) => found !== null)
      .map((found) => [found[1] ?? '', found[2] ?? '']),
  );
}

/**
 * Frontmatter as `key: value` lines.
 *
 * Enough of one to show which keys a use-case decided to change; how the real
 * one preserves bytes is `packages/adapters`' business and is tested there. As
 * the port promises, a null or undefined change removes the key.
 */
export function fakeMarkdown(): MarkdownPort {
  return {
    parseBody: () => {
      throw new Error('not used here');
    },
    plainText: () => '',
    textRanges: (body: string) => [{ start: 0, end: body.length }],
    serializeBody: () => {
      throw new Error('not used here');
    },
    rawParts: () => {
      throw new Error('not used here');
    },
    // A note's blocks are the parser's to find; a test of highlights passes its own.
    noteBlocks: () => ({ quotes: [], hidden: [] }),
    // A tree's markdown is the adapters' to write; written here as its JSON, which is enough
    // to show what a use-case wrote.
    writeTree: (root) => JSON.stringify(root),
    frontmatterProperties: (frontmatter) => Object.fromEntries(frontmatterLines(frontmatter)),
    frontmatterProblem: () => null,
    frontmatterKeyTexts: (frontmatter) =>
      Object.fromEntries(
        [...frontmatterLines(frontmatter)].map(([key, value]) => [key, `${key}: ${value}\n`]),
      ),
    updateFrontmatter: (frontmatter, changes) => {
      const merged = new Map<string, string>(
        [...frontmatterLines(frontmatter)].map(([key, value]) => [key, `${key}: ${value}`]),
      );
      for (const [key, change] of Object.entries(changes)) {
        if (change instanceof KeyAsWritten) {
          // A key given as written is its own line again, byte for byte, as
          // the real writer puts it back; text that is not that key removes it.
          if (frontmatterLines(change.text).has(key)) merged.set(key, change.text.trimEnd());
          else merged.delete(key);
        } else if (change === null || change === undefined) merged.delete(key);
        else merged.set(key, `${key}: ${String(change)}`);
      }
      return ['---', ...merged.values(), '---', ''].join('\n');
    },
    // `key: value` lines hold no map to add to.
    addToFrontmatterMap: () => null,
  };
}

/** No note open in any pane, unless a test says otherwise. */
export function fakeOpenNotes(overrides: Partial<OpenNotes> = {}): OpenNotes {
  return {
    state: () => 'closed',
    setPropertiesIfOpen: async () => false,
    reload: () => {},
    ...overrides,
  };
}
