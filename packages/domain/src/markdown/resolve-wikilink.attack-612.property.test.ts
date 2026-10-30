/**
 * Attack on PR #612 (#225): the `#` picker now answers from
 * `createWikiLinkResolver`, an index built once, where it searched with
 * `resolveWikiLinkTarget`. Over seeded vaults of namesakes — archived,
 * proposals, templates, case-only and NFC/NFD spellings — the two must agree
 * on every target, or the picker opens another note than the link does.
 * Fictional names only.
 */
import { describe, expect, it } from 'vitest';
import { createVaultPath, type VaultPath } from '../vault/vault-path.ts';
import { createWikiLinkResolver, resolveWikiLinkTarget } from './resolve-wikilink.ts';

function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FOLDERS = [
  '',
  'Projects/',
  'Archive/Projects/',
  'Inbox/Proposals/',
  '.atlas/templates/',
  'Areas/Garden/',
  'areas/garden/',
];
const NAMES = [
  'Larkspur',
  'larkspur',
  'LARKSPUR',
  'Café plan',
  'Café plan', // The same name, an e and a combining accent (NFD).
  'café Plan',
  'Seed swap',
  'İstanbul trip',
  'Straße',
];
const EXTENSIONS = ['.md', '.markdown', '.MD'];

function vaultOf(random: () => number): VaultPath[] {
  const pick = <T>(from: readonly T[]) => from[Math.floor(random() * from.length)] as T;
  const paths = new Set<string>();
  const size = 1 + Math.floor(random() * 12);
  while (paths.size < size) paths.add(`${pick(FOLDERS)}${pick(NAMES)}${pick(EXTENSIONS)}`);
  return [...paths].map((raw) => createVaultPath(raw));
}

function targetsOf(notes: readonly VaultPath[]): string[] {
  const asTyped = NAMES.flatMap((name) => [name, `${name}.md`, ` ${name} `]);
  const byPath = notes.flatMap((note) => [note, note.replace(/\.(md|markdown)$/i, '')]);
  return [...asTyped, ...byPath, ...byPath.map((path) => path.toUpperCase()), '', '   '];
}

describe('createWikiLinkResolver — the `#` picker’s index (#225, PR #612)', () => {
  it('opens the note resolveWikiLinkTarget opens, for every target over seeded vaults', () => {
    const random = seeded(612);
    const differ: string[] = [];
    for (let run = 0; run < 400; run += 1) {
      const notes = vaultOf(random);
      const resolve = createWikiLinkResolver(notes);
      for (const target of targetsOf(notes)) {
        const indexed = resolve(target);
        const searched = resolveWikiLinkTarget(target, notes);
        if (indexed !== searched) {
          differ.push(
            `${JSON.stringify(target)} in ${JSON.stringify(notes)}: ${indexed} ≠ ${searched}`,
          );
        }
      }
    }
    expect(differ.slice(0, 5)).toEqual([]);
  });

  it('never answers with a note that is not among the notes it was built over', () => {
    const random = seeded(225);
    for (let run = 0; run < 400; run += 1) {
      const notes = vaultOf(random);
      const resolve = createWikiLinkResolver(notes);
      for (const target of targetsOf(notes)) {
        const found = resolve(target);
        if (found !== null) expect(notes).toContain(found);
      }
    }
  });
});
