import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The app's stylesheet is `styles/index.css` importing one file per section
 * (UI v2 slice 0b). The tests that hold the sheet to its rules read it the
 * way the build ships it: every section file, in import order, as one sheet.
 */

const inStyles = (name: string) => fileURLToPath(new URL(`./styles/${name}`, import.meta.url));

/** The section files `index.css` imports, in the order it imports them. */
export function importedSections(): string[] {
  const index = readFileSync(inStyles('index.css'), 'utf8');
  return [...index.matchAll(/^@import\s+'\.\/([a-z0-9-]+\.css)';$/gm)].map((m) => m[1] ?? '');
}

/** Every `.css` file in the folder but the index itself, by name. */
export function sectionFilesOnDisk(): string[] {
  return readdirSync(inStyles(''))
    .filter((name) => name.endsWith('.css') && name !== 'index.css')
    .sort();
}

/** `index.css` as written: what a scan of the index alone would see. */
export function readIndex(): string {
  return readFileSync(inStyles('index.css'), 'utf8');
}

/** The whole sheet: the section files joined in cascade order. */
export function readStylesheet(): string {
  return importedSections()
    .map((name) => readFileSync(inStyles(name), 'utf8'))
    .join('\n');
}
