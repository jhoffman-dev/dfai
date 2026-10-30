import { createVaultPath as p, type VaultEntry } from '@dfai/domain';
import type { MarkdownPort } from '../notes/ports.ts';
import type { VaultFsPort } from '../vault/ports.ts';

/*
 * A vault in memory for use-cases that write many notes: frontmatter held as
 * JSON (enough for lists and relations), and writes guarded as the host
 * guards them — by modification time and by the text last read. Test support only.
 */

/** Frontmatter as JSON between the fences: enough to hold lists and relations. */
export const jsonFrontmatterMarkdown: MarkdownPort = {
  parseBody: () => ({ blocks: [], doc: { type: 'doc', content: [] } }),
  serializeBody: () => '',
  rawParts: () => [],
  noteBlocks: () => ({ quotes: [], hidden: [] }),
  writeTree: () => '',
  addToFrontmatterMap: () => null,
  frontmatterProblem: (frontmatter) =>
    frontmatter !== null && frontmatter.includes('BROKEN') ? 'a bad line' : null,
  frontmatterKeyTexts: () => ({}),
  frontmatterProperties: (frontmatter) =>
    frontmatter === null
      ? {}
      : (JSON.parse(frontmatter.replace(/^---\n/, '').replace(/---\n?$/, '')) as Record<
          string,
          unknown
        >),
  plainText: (body) => body.trim(),
  textRanges: (body: string) => [{ start: 0, end: body.length }],
  updateFrontmatter: (frontmatter, changes) => {
    const before = jsonFrontmatterMarkdown.frontmatterProperties(frontmatter);
    return `---\n${JSON.stringify({ ...before, ...changes })}\n---\n`;
  },
};

export const jsonFrontmatterNote = (properties: Record<string, unknown>, body: string) =>
  `---\n${JSON.stringify(properties)}\n---\n${body}`;

interface Stored {
  text: string;
  modified: number;
}

/** A vault in memory whose writes are guarded as the host guards them, and counted. */
export function guardedVault(entries: Record<string, string>) {
  const files = new Map<string, Stored>(
    Object.entries(entries).map(([path, text]) => [path, { text, modified: 1 }]),
  );
  const writes: string[] = [];
  const trashed: string[] = [];
  const failWrite = new Set<string>();
  const failTrash = new Set<string>();
  const fs: VaultFsPort = {
    listDirectory: async (folder) =>
      [...files.keys()]
        .filter(
          (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '') === folder,
        )
        .map((path): VaultEntry => ({
          kind: 'file',
          name: path.split('/').at(-1)!,
          path: p(path),
        })),
    listFiles: async () => [],
    listNotes: async () =>
      [...files]
        .filter(([path]) => path.endsWith('.md'))
        .map(([path, { text, modified }]) => ({
          name: path.split('/').at(-1) ?? path,
          path: p(path),
          modified,
          size: text.length,
        })),
    readNotes: async (paths) =>
      paths.flatMap((path) => {
        const file = files.get(path);
        return file === undefined ? [] : [{ path, ...file, size: file.text.length }];
      }),
    readBinaryFile: async () => new ArrayBuffer(0),
    createNote: async () => 0,
    createFolder: async () => {},
    moveEntry: async () => {},
    trashEntry: async ({ path }) => {
      if (failTrash.has(path)) throw new Error('The Trash refused it.');
      files.delete(path);
      trashed.push(path);
    },
    writeBinaryFile: async () => 0,
    readTextFile: async (path) => {
      const file = files.get(path);
      if (file === undefined) throw new Error(`${path} is not there`);
      return { ...file };
    },
    writeTextFile: async ({ path, contents, expectedModified, expectedText }) => {
      const file = files.get(path);
      if (failWrite.has(path)) throw new Error('The disk is full.');
      if (file === undefined || file.modified !== expectedModified || file.text !== expectedText) {
        throw new Error(`${path} changed on disk`);
      }
      writes.push(path);
      files.set(path, { text: contents, modified: file.modified + 1 });
      return file.modified + 1;
    },
  };
  const text = (path: string) => files.get(path)?.text;
  const edit = (path: string, contents: string) => {
    const file = files.get(path)!;
    files.set(path, { text: contents, modified: file.modified + 1 });
  };
  return { fs, files, writes, trashed, failWrite, failTrash, text, edit };
}
