/**
 * Adversarial tests for saving a hand-written SKILL.md through the real
 * markdown port (PR #620, ADR-0050, ADR-0003), over seeded hostile files: a
 * byte-order mark, CRLF, no final newline, comments, unknown and quoted keys,
 * folded and literal descriptions, and a body holding `---`. ADR-0050 says
 * "a hand-written SKILL.md keeps every byte an edit did not touch".
 */

import { describe, expect, it } from 'vitest';
import { apiFixture, readSkill, saveSkill } from '@dfai/application';
import { remarkMarkdown } from './markdown-port.ts';

const PATH = '.atlas/skills/weekly-review/SKILL.md';

/** mulberry32: a seeded RNG, so every run draws the same files. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(random: () => number, items: readonly T[]): T =>
  items[Math.floor(random() * items.length)] as T;

/** The description entry's own lines, in the forms people write it. */
const DESCRIPTIONS: readonly string[][] = [
  ['description: Old words.'],
  ['description: "Old words."'],
  ["description: 'Old words.'"],
  ['"description": Old words.'],
  ['description: Old words. # mine'],
  ['description: >', '  Old', '  words.'],
  ['description: |-', '  Old', '  words.'],
  ['description: Old', '  words.'],
];

/** Other frontmatter lines, none of which an edit of the description may touch. */
const OTHERS: readonly string[][] = [
  ['# written by hand'],
  ['license:   MIT'],
  ["'quoted-key': kept"],
  ['metadata:', '  owner: Tobias Fenn', '  tags: [a,  b]'],
  ['allowed-tools: Read  Grep'],
  ['version: 1.0   # pinned'],
];

const BODIES = [
  'Step one.\n',
  'Step one.\n\n---\n\nStep two after a rule.\n',
  'Step one.',
  '  indented\n\ttabbed\n',
  '---\nnot: frontmatter\n---\n',
];

/** A hostile SKILL.md with one line ending throughout. */
function drawSkill(random: () => number): string {
  const eol = random() < 0.5 ? '\n' : '\r\n';
  const bom = random() < 0.2 ? '﻿' : '';
  const lines = [['name: weekly-review'], pick(random, DESCRIPTIONS)];
  // Each other key at most once: a duplicate key is a file that cannot be read.
  const others = OTHERS.filter(() => random() < 0.4);
  for (const other of others) lines.splice(Math.floor(random() * (lines.length + 1)), 0, other);
  const frontmatter = lines.flat().join(eol);
  const gap = random() < 0.7 ? eol : '';
  const body = pick(random, BODIES).replace(/\n/g, eol);
  return `${bom}---${eol}${frontmatter}${eol}---${eol}${gap}${body}`;
}

function vault(text: string) {
  const fixture = apiFixture({
    files: { '.atlas/settings.md': '', [PATH]: text },
    markdown: remarkMarkdown,
  });
  const read = async () => {
    const skill = await readSkill({
      fs: fixture.fs,
      markdown: remarkMarkdown,
      name: 'weekly-review',
    });
    if (skill === null) throw new Error('no skill');
    return skill;
  };
  return { fixture, read };
}

/** Each line of `text` that is not part of the description entry, line end and all. */
function linesBesideDescription(text: string): string[] {
  const lines = text.split(/(?<=\n)/);
  const kept: string[] = [];
  let inDescription = false;
  for (const line of lines) {
    if (/^"?description"?:/.test(line)) {
      inDescription = true;
      continue;
    }
    if (inDescription && /^ {2}\S/.test(line)) continue;
    inDescription = false;
    kept.push(line);
  }
  return kept;
}

const SEEDS = Array.from({ length: 60 }, (_, at) => 620_000 + at);

describe('a hand-written SKILL.md, over seeded hostile files', () => {
  it('is not written at all by a save that changes nothing', async () => {
    for (const seed of SEEDS) {
      const text = drawSkill(seeded(seed));
      const { fixture, read } = vault(text);
      const skill = await read();

      await saveSkill({
        fs: fixture.fs,
        markdown: remarkMarkdown,
        skill,
        draft: {
          name: skill.name,
          description: skill.description,
          instructions: skill.instructions,
        },
      });

      expect({ seed, writes: fixture.writes }).toEqual({ seed, writes: [] });
    }
  });

  it('reads back exactly the description and instructions saved (parse, edit, parse)', async () => {
    for (const seed of SEEDS) {
      const text = drawSkill(seeded(seed));
      const { fixture, read } = vault(text);
      const skill = await read();
      // As an editor's form sends text: bare line feeds.
      const draft = {
        name: skill.name,
        description: 'New: "words" # not a comment',
        instructions: `${skill.instructions.replace(/\r\n/g, '\n')}More.\n`,
      };

      await saveSkill({ fs: fixture.fs, markdown: remarkMarkdown, skill, draft });
      const again = await read();

      // A body written with CRLF keeps it (ADR-0050), so line ends are compared apart.
      const mixed = /\r\n/.test(again.instructions) && /(?<!\r)\n/.test(again.instructions);
      expect({
        seed,
        description: again.description,
        instructions: again.instructions.replace(/\r\n/g, '\n'),
        mixed,
      }).toEqual({
        seed,
        description: draft.description,
        instructions: draft.instructions,
        mixed: false,
      });
      expect({ seed, problems: again.problems }).toEqual({ seed, problems: skill.problems });
    }
  });

  it('changes no byte outside the description entry when only the description is edited', async () => {
    for (const seed of SEEDS) {
      const text = drawSkill(seeded(seed));
      const { fixture, read } = vault(text);
      const skill = await read();

      await saveSkill({
        fs: fixture.fs,
        markdown: remarkMarkdown,
        skill,
        draft: { name: skill.name, description: 'New words.', instructions: skill.instructions },
      });

      const after = fixture.files.get(PATH)?.text ?? '';
      expect({ seed, lines: linesBesideDescription(after) }).toEqual({
        seed,
        lines: linesBesideDescription(text),
      });
    }
  });
});

describe('a SKILL.md with mixed line endings', () => {
  it('keeps the CRLF on the other keys’ lines when only the description is edited', async () => {
    const text =
      '---\nname: weekly-review\r\ndescription: Old words.\nlicense: MIT\r\n---\n\nStep.\n';
    const { fixture, read } = vault(text);
    const skill = await read();

    await saveSkill({
      fs: fixture.fs,
      markdown: remarkMarkdown,
      skill,
      draft: { name: skill.name, description: 'New words.', instructions: skill.instructions },
    });

    expect(fixture.files.get(PATH)?.text).toBe(text.replace('Old words.', 'New words.'));
  });

  it('keeps the LF on the other keys’ lines of a file that opens with CRLF', async () => {
    const text =
      '---\r\nname: weekly-review\ndescription: Old words.\r\nlicense: MIT\n---\r\n\r\nStep.\r\n';
    const { fixture, read } = vault(text);
    const skill = await read();

    await saveSkill({
      fs: fixture.fs,
      markdown: remarkMarkdown,
      skill,
      draft: { name: skill.name, description: 'New words.', instructions: skill.instructions },
    });

    expect(fixture.files.get(PATH)?.text).toBe(text.replace('Old words.', 'New words.'));
  });
});
