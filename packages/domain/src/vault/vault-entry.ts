import { vaultPathName, type VaultPath } from './vault-path.ts';

export interface VaultFile {
  readonly kind: 'file';
  readonly name: string;
  readonly path: VaultPath;
  /** When it last changed, in milliseconds, where the host said. */
  readonly modified?: number;
  /** How many bytes it holds, where the host said. */
  readonly size?: number;
  /** Whether it is a symlink, where the host said; absent for one that is not. */
  readonly link?: true;
}

export interface VaultDirectory {
  readonly kind: 'directory';
  readonly name: string;
  readonly path: VaultPath;
  /** Whether it is a symlink, where the host said; absent for one that is not. */
  readonly link?: true;
}

export type VaultEntry = VaultFile | VaultDirectory;

const MARKDOWN_EXTENSIONS = ['.md', '.markdown'];

export function isMarkdownFile(entry: VaultEntry): boolean {
  return entry.kind === 'file' && isMarkdownName(entry.name);
}

/** Whether a file name, or a path, is a note's. */
export function isMarkdownName(name: string): boolean {
  return MARKDOWN_EXTENSIONS.some((extension) => name.toLowerCase().endsWith(extension));
}

/** The display title of a note: its filename without the markdown extension. */
export function noteTitle(path: VaultPath): string {
  const name = vaultPathName(path);
  const extension = MARKDOWN_EXTENSIONS.find((candidate) => name.toLowerCase().endsWith(candidate));
  return extension === undefined ? name : name.slice(0, -extension.length);
}
