import { describe, expect, it } from 'vitest';
import {
  createWikiLinkResolver,
  createVaultPath,
  splitFrontmatter,
  startTrail,
  stepTo,
  wikiLinkSpans,
} from '@dfai/domain';
import { fakeIndexPort, fakeVaultFs } from '../testing/fake-ports.ts';
import { acceptRelatedNote } from './accept-related-note.ts';
import { saveTrail } from './save-trail.ts';

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

const manifestOf = (paths: readonly string[]) =>
  fakeIndexPort({
    manifest: async () =>
      paths.map((path) => ({ path, digest: path, type: null, modified: 1, size: 1 })),
  });

function disk(files: Record<string, string>) {
  const held = new Map(Object.entries(files));
  const modified = new Map<string, number>([...held.keys()].map((path) => [path, 1]));
  const fs = fakeVaultFs({
    readTextFile: async (path) => ({
      text: held.get(path) ?? '',
      modified: modified.get(path) ?? 0,
    }),
    writeTextFile: async ({ path, contents, expectedModified }) => {
      if (expectedModified !== modified.get(path)) throw new Error('changed on disk');
      held.set(path, contents);
      modified.set(path, (modified.get(path) ?? 0) + 1);
      return modified.get(path) as number;
    },
    createNote: async ({ path, contents }) => {
      if (held.has(path)) throw new Error('taken');
      held.set(path, contents);
      return 1;
    },
  });
  return { fs, held };
}

const FOLDERS = ['', 'Home/', 'home/', 'Work/Deep/', 'Archive/', '.atlas/inbox/'];
const NAMES = ['Bees', 'bees', 'BEES', 'Café', 'Café', 'Honey', 'Bees 2'];

describe('acceptRelatedNote links the intended note, as the repo resolves links', () => {
  it('writes a link that opens the accepted note among namesakes, cases and Unicode forms', async () => {
    const random = seeded(2026);
    const wrong: string[] = [];
    for (let round = 0; round < 300; round += 1) {
      // As APFS holds them: one file per path whatever its case or Unicode form.
      const paths = new Map<string, string>();
      const count = 2 + Math.floor(random() * 6);
      for (let tries = 0; paths.size < count && tries < 50; tries += 1) {
        const folder = FOLDERS[Math.floor(random() * FOLDERS.length)] as string;
        const name = NAMES[Math.floor(random() * NAMES.length)] as string;
        const path = `${folder}${name}.md`;
        const key = path.normalize('NFC').toLowerCase();
        if (!paths.has(key)) paths.set(key, path);
      }
      const notes = [...paths.values()];
      const userNotes = notes.filter((path) => !path.startsWith('.atlas/'));
      if (userNotes.length === 0) continue;
      const target = userNotes[Math.floor(random() * userNotes.length)] as string;
      const note = 'Plan.md';
      const { fs, held } = disk({ [note]: 'Mara Quill moves payday.\n' });
      await acceptRelatedNote({
        fs,
        index: manifestOf([note, ...notes]),
        note: createVaultPath(note),
        target: createVaultPath(target),
      });
      const resolve = createWikiLinkResolver([note, ...notes].map(createVaultPath));
      const links = wikiLinkSpans(held.get(note) as string).map((span) => span.link);
      const opens = links.map((link) => resolve(link.target));
      if (opens.length !== 1 || opens[0] !== target)
        wrong.push(`${target} among ${notes.join(', ')} -> ${String(opens[0])}`);
    }
    expect(wrong.slice(0, 3)).toEqual([]);
  });

  it('never writes a link into the note to the note itself', async () => {
    const { fs, held } = disk({ 'Plan.md': 'Mara Quill.\n' });
    await acceptRelatedNote({
      fs,
      index: manifestOf(['Plan.md']),
      note: createVaultPath('Plan.md'),
      target: createVaultPath('Plan.md'),
    }).catch(() => false);
    expect(held.get('Plan.md')).toBe('Mara Quill.\n');
  });

  it('never writes a link to a template, which no link can open', async () => {
    const { fs, held } = disk({ 'Plan.md': 'Mara Quill.\n' });
    await acceptRelatedNote({
      fs,
      index: manifestOf(['Plan.md', '.atlas/templates/Meeting.md']),
      note: createVaultPath('Plan.md'),
      target: createVaultPath('.atlas/templates/Meeting.md'),
    }).catch(() => false);
    expect(held.get('Plan.md')).toBe('Mara Quill.\n');
  });

  it('keeps a BOM-led frontmatter file as frontmatter, adding only after its body', async () => {
    const text = '﻿---\ntitle: Plan\n---\nBody\n';
    const { fs, held } = disk({ 'Plan.md': text });
    await acceptRelatedNote({
      fs,
      index: manifestOf(['Plan.md', 'Honey.md']),
      note: createVaultPath('Plan.md'),
      target: createVaultPath('Honey.md'),
    });
    const written = held.get('Plan.md') as string;
    expect(written.startsWith(text)).toBe(true);
    expect(splitFrontmatter(written).bodyOffset).toBe(splitFrontmatter(text).bodyOffset);
  });
});

describe('acceptRelatedNote into a note that ends in an open code block', () => {
  it('writes the link once however often the note is accepted', async () => {
    const text = 'Mara Quill\n```\nconst pay = 1;\n';
    const { fs, held } = disk({ 'Plan.md': text });
    const accept = () =>
      acceptRelatedNote({
        fs,
        index: manifestOf(['Plan.md', 'Honey.md']),
        note: createVaultPath('Plan.md'),
        target: createVaultPath('Honey.md'),
      });
    await accept();
    // The graph never sees a link inside code, so the note is offered, and accepted, again.
    await accept();
    expect((held.get('Plan.md') as string).split('[[Honey]]').length - 1).toBe(1);
  });
});

describe('saveTrail, attacked', () => {
  const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

  it('numbers past many trails already saved from the same note', async () => {
    const taken = ['Ideas/Payroll.md', 'Ideas/Trail from Payroll.md'];
    for (let n = 2; n <= 40; n += 1) taken.push(`Ideas/Trail from Payroll ${n}.md`);
    const { fs } = disk(Object.fromEntries(taken.map((path) => [path, ''])));
    const path = await saveTrail({
      fs,
      index: manifestOf(taken),
      trail: startTrail('Ideas/Payroll.md'),
    });
    expect(path).toBe('Ideas/Trail from Payroll 41.md');
  });

  it('names the trail of a long-named note within the 255 bytes a file name may have', async () => {
    const start = `Ideas/${'Mara Quill payroll thoughts '.repeat(9).trim()}.md`;
    expect(utf8Bytes(start.slice('Ideas/'.length))).toBeLessThanOrEqual(255);
    const { fs } = disk({ [start]: '' });
    const path = await saveTrail({ fs, index: manifestOf([start]), trail: startTrail(start) });
    expect(utf8Bytes(path.slice(path.lastIndexOf('/') + 1))).toBeLessThanOrEqual(255);
  });

  it('writes no link to a step deleted since it was walked', async () => {
    const trail = ['Ideas/Gone.md', 'Ideas/Budget.md'].reduce(
      stepTo,
      startTrail('Ideas/Payroll.md'),
    );
    const notes = ['Ideas/Payroll.md', 'Ideas/Budget.md'];
    const { fs, held } = disk({});
    const path = await saveTrail({ fs, index: manifestOf(notes), trail });
    const resolve = createWikiLinkResolver(notes.map(createVaultPath));
    const dead = wikiLinkSpans(held.get(path) as string)
      .map((span) => span.link.target)
      .filter((target) => resolve(target) === null);
    expect(dead).toEqual([]);
  });
});
