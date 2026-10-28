/**
 * Adversarial tests for the skill rules (PR #620, #169), each held to an
 * oracle written from the Agent Skills rules rather than from the code:
 *
 * - name: lowercase ASCII letters, digits and single hyphens, never at either
 *   end; 1 to 64 characters; neither "claude" nor "anthropic" anywhere.
 * - description: not blank, at most 1024 characters (code points, as the
 *   Python validator Agent Skills ship counts them), no XML tags — a tag
 *   being XML 1.0's: `<`, an optional `/`, then a name that starts with any
 *   letter or `_`/`:`.
 * - two folder names are one on APFS when they match after canonical
 *   decomposition and case folding; DFAI must see every such pair as taken.
 *
 * Seeded (mulberry32), so every run draws the same inputs.
 */

import { describe, expect, it } from 'vitest';
import {
  isSkillNameTaken,
  MAX_SKILL_DESCRIPTION_LENGTH,
  skillDescriptionProblem,
  skillNameProblem,
} from './skill-rules.ts';

/** mulberry32: a seeded RNG, so every run draws the same strings. */
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

const RESERVED = ['claude', 'anthropic'];

/** The Agent Skills name rule, written from the rule's words. */
function nameIsLegal(name: string): boolean {
  const length = [...name].length;
  if (length < 1 || length > 64) return false;
  if (!/^[a-z0-9-]+$/.test(name)) return false;
  if (name.startsWith('-') || name.endsWith('-') || name.includes('--')) return false;
  return !RESERVED.some((word) => name.includes(word));
}

/** An XML 1.0 start, end or empty-element tag, its name in any script. */
const XML_TAG_ORACLE = /<\/?[\p{L}_:][\p{L}\p{N}\p{M}_.:\-·]*(?:\s[^<>]*)?\/?>/u;

/** The Agent Skills description rule, written from the rule's words. */
function descriptionIsLegal(description: string): boolean {
  if (description.trim() === '') return false;
  if ([...description].length > MAX_SKILL_DESCRIPTION_LENGTH) return false;
  return !XML_TAG_ORACLE.test(description);
}

/** Whether APFS (case- and normalization-insensitive) holds two names as one. */
function apfsSame(left: string, right: string): boolean {
  const fold = (name: string) => name.normalize('NFD').toLowerCase().replace(/ſ/g, 's');
  return fold(left) === fold(right);
}

const NAME_PIECES = [
  'a',
  'z',
  '0',
  '9',
  '-',
  '--',
  'weekly',
  'review',
  'claude',
  'anthropic',
  'Claude',
  'A',
  '_',
  ' ',
  '.',
  'ａ', // fullwidth a
  'K', // Kelvin sign
  'ſ', // long s
  'ı', // dotless i
  'İ', // dotted capital I
  'é', // e + combining acute
  'é', // é precomposed
  'а', // Cyrillic a
  '​', // zero-width space
];

function drawName(random: () => number): string {
  const pieces = Math.floor(random() * 14);
  let name = '';
  for (let at = 0; at < pieces; at += 1) name += pick(random, NAME_PIECES);
  if (random() < 0.1) name = name.padEnd(60 + Math.floor(random() * 10), 'x');
  return name;
}

describe('the name rule against the Agent Skills oracle', () => {
  it('accepts exactly the names the oracle accepts, over 4000 seeded names', () => {
    const random = seeded(620);
    const disagreements: string[] = [];
    for (let draw = 0; draw < 4000; draw += 1) {
      const name = drawName(random);
      if ((skillNameProblem(name) === null) !== nameIsLegal(name)) {
        disagreements.push(JSON.stringify(name));
      }
    }
    expect(disagreements.slice(0, 5)).toEqual([]);
  });
});

describe('a name APFS cannot tell from a folder already there', () => {
  it('is always taken, over 4000 seeded folder names', () => {
    const random = seeded(1690);
    const missed: string[] = [];
    for (let draw = 0; draw < 4000; draw += 1) {
      const folder = drawName(random);
      const asked = folder.normalize('NFD').toLowerCase().replace(/ſ/g, 's');
      if (!nameIsLegal(asked) || !apfsSame(asked, folder)) continue;
      if (!isSkillNameTaken(asked, [folder])) missed.push(`${asked} vs ${JSON.stringify(folder)}`);
    }
    expect(missed.slice(0, 5)).toEqual([]);
  });
});

const DESCRIPTION_PIECES = [
  'Use when',
  ' ',
  'Mara Quill',
  ' asks.',
  '<',
  '>',
  'a < b',
  'b > a',
  '&amp;',
  '&lt;tag&gt;',
  '<![CDATA[ raw ]]>',
  '<!-- note -->',
  '<?pi x?>',
  '<example>',
  '</b>',
  '<br/>',
  '<ns:tag attr="1">',
  '< spaced>',
  '<1digit>',
  '<résumé>',
  '<名前>', // a tag named in kanji
  '</über>',
  '\u{1F600}',
  'é',
  '\n',
];

function drawDescription(random: () => number): string {
  const pieces = 1 + Math.floor(random() * 6);
  let description = '';
  for (let at = 0; at < pieces; at += 1) description += pick(random, DESCRIPTION_PIECES);
  if (random() < 0.2) {
    const fill = pick(random, ['x', '\u{1F600}', 'é']);
    const room = 1000 + Math.floor(random() * 40) - [...description].length;
    description += fill.repeat(Math.max(0, Math.floor(room / [...fill].length)));
  }
  return description;
}

describe('the description rule against the Agent Skills oracle', () => {
  it('accepts exactly the descriptions the oracle accepts, over 4000 seeded descriptions', () => {
    const random = seeded(1024);
    const disagreements: string[] = [];
    for (let draw = 0; draw < 4000; draw += 1) {
      const description = drawDescription(random);
      if ((skillDescriptionProblem(description) === null) !== descriptionIsLegal(description)) {
        disagreements.push(JSON.stringify(description.slice(0, 40)));
      }
    }
    expect(disagreements.slice(0, 5)).toEqual([]);
  });

  it.each([
    ['accented Latin', 'Fills in the <résumé> section.'],
    ['kanji', 'Use for <名前> fields.'],
    ['a closing tag in German', 'Ends with </über>.'],
    ['Greek', 'Wraps text in <α>.'],
  ])('refuses an XML tag whose name is in %s', (_script, description) => {
    expect(skillDescriptionProblem(description)).toBe(
      'A skill’s description cannot hold XML tags.',
    );
  });

  it('counts its length in characters, so 1024 emoji are a legal description', () => {
    const description = '\u{1F600}'.repeat(MAX_SKILL_DESCRIPTION_LENGTH);

    expect([...description]).toHaveLength(MAX_SKILL_DESCRIPTION_LENGTH);
    expect(skillDescriptionProblem(description)).toBeNull();
  });

  it('still refuses 1025 characters, however they are encoded', () => {
    expect(skillDescriptionProblem('x'.repeat(MAX_SKILL_DESCRIPTION_LENGTH + 1))).not.toBeNull();
    expect(
      skillDescriptionProblem('\u{1F600}'.repeat(MAX_SKILL_DESCRIPTION_LENGTH + 1)),
    ).not.toBeNull();
  });
});
