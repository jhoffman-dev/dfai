import type { VaultPath } from '../vault/vault-path.ts';

/*
 * Where an export's files go and what they are called (#501). One note goes
 * to the file the person picks, its attachments to a folder beside it named
 * after it; several go into a folder of their own, their attachments shared
 * in one `attachments` folder inside it.
 */

/** The formats a note leaves DFAI in. */
export const EXPORT_FORMATS = ['markdown', 'standalone', 'pdf', 'google-doc'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export function isExportFormat(value: unknown): value is ExportFormat {
  return (EXPORT_FORMATS as readonly unknown[]).includes(value);
}

/** What the folder of attachments beside one exported note is called: "Kickoff attachments". */
export const COMPANION_SUFFIX = ' attachments';

/** Where several notes' attachments go, inside the folder they are exported to. */
export const SHARED_ATTACHMENTS_FOLDER = 'attachments';

/**
 * The most UTF-8 bytes a name's stem takes. A Mac's disk holds a name of 255
 * bytes; the stem leaves room for " attachments", a number (" 999") and an
 * extension, so every name an export makes from it fits (#502).
 */
const MAX_STEM_BYTES = 255 - COMPANION_SUFFIX.length - ' 999'.length - '.jpeg'.length;

const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).byteLength;

/** `text` cut to at most `max` UTF-8 bytes, never inside a character. */
function cutToBytes(text: string, max: number): string {
  let cut = '';
  for (const character of text) {
    if (byteLength(cut + character) > max) break;
    cut += character;
  }
  return cut;
}

/**
 * A name as a Mac's disk compares it: composed (NFC) — "Café" typed two
 * ways is one name — and without case.
 */
const sameNameKey = (name: string) => name.normalize('NFC').toLowerCase();

/** Characters a file name cannot hold on a Mac, in Windows or for a shell, and control characters. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
const UNSAFE = /[/\\:*?"<>|\u0000-\u001f\u007f]/g;

/**
 * A note's title as a file name: what no file system takes made a dash,
 * leading dots and trailing spaces or dots dropped, and cut to a length any
 * takes. A title with nothing left is "Untitled".
 */
export function exportFileStem(title: string): string {
  const safe = title
    .normalize('NFC')
    .replace(UNSAFE, '-')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');
  const cut = cutToBytes(safe, MAX_STEM_BYTES).trimEnd();
  return cut === '' ? 'Untitled' : cut;
}

/** The file name a note is exported as: "Kickoff.md". */
export function exportFileName(title: string, extension: string): string {
  return `${exportFileStem(title)}.${extension}`;
}

/**
 * Names for several files in one folder, in order, none the same as another
 * as a Mac's disk compares them — composed, without case: "Notes.md",
 * "Notes 2.md".
 */
export function uniqueFileNames(stems: readonly string[], extension: string): string[] {
  const taken = new Set<string>();
  return stems.map((given) => {
    const stem = given.normalize('NFC');
    for (let count = 1; ; count += 1) {
      const name = count === 1 ? `${stem}.${extension}` : `${stem} ${count}.${extension}`;
      if (!taken.has(sameNameKey(name))) {
        taken.add(sameNameKey(name));
        return name;
      }
    }
  });
}

/** A file name split at its last dot: "plan.v2.png" is "plan.v2" and "png". */
function splitExtension(name: string): { stem: string; extension: string } {
  const dot = name.lastIndexOf('.');
  return dot <= 0
    ? { stem: name, extension: '' }
    : { stem: name.slice(0, dot), extension: name.slice(dot + 1) };
}

/**
 * The name each attachment is copied as, by its vault path: its own file
 * name, with what no file system takes made a dash (as `exportFileStem`
 * does), numbered where two from different folders share one.
 */
export function attachmentFileNames(paths: readonly VaultPath[]): Map<VaultPath, string> {
  const unique = [...new Set(paths)];
  const taken = new Set<string>();
  const names = new Map<VaultPath, string>();
  for (const path of unique) {
    const file = (path.split('/').at(-1) ?? path).normalize('NFC').replace(UNSAFE, '-');
    const split = splitExtension(file);
    const extension = split.extension;
    const stem = cutToBytes(split.stem, MAX_STEM_BYTES);
    for (let count = 1; ; count += 1) {
      const base = count === 1 ? stem : `${stem} ${count}`;
      const name = extension === '' ? base : `${base}.${extension}`;
      if (!taken.has(sameNameKey(name))) {
        taken.add(sameNameKey(name));
        names.set(path, name);
        break;
      }
    }
  }
  return names;
}

/**
 * A relative path as a Markdown link writes it: each part percent-encoded,
 * parentheses too, so a space, a bracket or a `)` in a name cannot end the
 * link early.
 */
export function markdownHref(relativePath: string): string {
  const encoded = (part: string) =>
    encodeURIComponent(part).replace(/[()]/g, (paren) => (paren === '(' ? '%28' : '%29'));
  return relativePath.split('/').map(encoded).join('/');
}

/** The folder several notes are exported into, dated: "Exported notes 2026-10-21". */
export function exportFolderName(today: string): string {
  return `Exported notes ${today}`;
}

/** The folder a Google Doc goes to when the person names none: "<app> exports". */
export function defaultDriveFolderName(appName: string): string {
  return `${appName} exports`;
}
