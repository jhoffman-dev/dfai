/**
 * #739: a seeded fuzz of blocks holding `|+` (keep) text — with blank lines,
 * lines of spaces and comments after it, at the top level and inside a map —
 * under one change each. A write may be refused; one that is not must read
 * back, as DFAI reads it, exactly as asked, and write no comment more often
 * than the block held it, losing none when a key is added or entries move.
 */
import { describe, expect, it } from 'vitest';
import { Lexer } from 'yaml';
import { FrontmatterRefusedError } from '@dfai/application';
import { updateFrontmatter } from './frontmatter-write.ts';
import { parseFrontmatterProperties } from './frontmatter.ts';
import { seeded } from './frontmatter-write-cases.attack-454.ts';

type Random = () => number;
type Operation = 'change' | 'add' | 'delete' | 'move' | 'delete-entry';

interface Case {
  original: string;
  changes: Record<string, unknown>;
  operation: Operation;
}

const pick = <T>(random: Random, items: readonly T[]): T =>
  items[Math.floor(random() * items.length)] as T;

const blankLine = (random: Random, indent: string) =>
  pick(random, ['', ' ', indent, `${indent}  `]);

let commentCount = 0;
const comment = (indent: string) => `${indent}# c${(commentCount += 1)}`;

/** One value's lines after `key:`, at `indent`. */
function valueLines(random: Random, indent: string): { head: string; lines: string[] } {
  const kind = pick(random, ['keep', 'keep', 'keep', 'clip', 'plain', 'empty']);
  if (kind === 'plain') return { head: ' v', lines: [] };
  if (kind === 'empty') return { head: '', lines: [] };
  const text = [`${indent}  x`, ...(random() < 0.4 ? [`${indent}  y`] : [])];
  const blanks = Array.from({ length: Math.floor(random() * 3) }, () => blankLine(random, indent));
  return { head: kind === 'keep' ? ' |+' : ' |', lines: [...text, ...blanks] };
}

function entries(random: Random, indent: string, prefix: string, count: number): string[] {
  const lines: string[] = [];
  for (let at = 0; at < count; at += 1) {
    if (random() < 0.3) lines.push(comment(random() < 0.5 ? indent : ''));
    const { head, lines: below } = valueLines(random, indent);
    lines.push(`${indent}${prefix}${at}:${head}`, ...below);
  }
  return lines;
}

const givenValue = (random: Random) => pick(random, ['y\n', 'y\n\n', 'y\n\n\n', 'z', 7]);

function generated(random: Random): Case {
  const top = entries(random, '', 'k', 1 + Math.floor(random() * 3));
  const map = ['properties:', ...entries(random, '  ', 'p', 2 + Math.floor(random() * 2))];
  const lines = random() < 0.5 ? [...top, ...map] : [...map, ...top];
  if (random() < 0.3) lines.push(comment(''));
  if (random() < 0.4) lines.push('');
  const original = `---\n${lines.join('\n')}\n---\n`;
  const read = parseFrontmatterProperties(original);
  const properties = read.properties as Record<string, unknown>;
  const operation = pick<Operation>(random, ['change', 'add', 'delete', 'move', 'delete-entry']);
  const someKey = pick(random, Object.keys(read));
  const someEntry = pick(random, Object.keys(properties));
  const changes: Record<string, unknown> = {
    change: { [someKey]: givenValue(random) },
    add: { added: givenValue(random) },
    delete: { [someKey]: null },
    move: { properties: Object.fromEntries(Object.entries(properties).reverse()) },
    'delete-entry': {
      properties: Object.fromEntries(Object.entries(properties).filter(([key]) => key !== someEntry)),
    },
  }[operation];
  return { original, changes, operation };
}

/** What the block should read as: each change applied, `null` taking the key away. */
function expected(original: string, changes: Record<string, unknown>) {
  const values: Record<string, unknown> = { ...parseFrontmatterProperties(original) };
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) delete values[key];
    else values[key] = value;
  }
  return values;
}

const commentCounts = (frontmatter: string) => {
  const counts = new Map<string, number>();
  for (const token of new Lexer().lex(frontmatter.replace(/^---\n|---\n$/g, ''))) {
    if (token.startsWith('#')) counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
};

/** What is wrong with the case's write; empty when it is refused or right. */
function problemsOf({ original, changes, operation }: Case): string[] {
  let written: string;
  try {
    written = updateFrontmatter(original, changes);
  } catch (error) {
    if (error instanceof FrontmatterRefusedError) return [];
    throw error;
  }
  const problems: string[] = [];
  const read = JSON.stringify(parseFrontmatterProperties(written));
  if (read !== JSON.stringify(expected(original, changes))) problems.push(`reads ${read}`);
  const [has, had] = [commentCounts(written), commentCounts(original)];
  for (const [text, count] of has) {
    if (count > (had.get(text) ?? 0)) problems.push(`${text} written ${count} times`);
  }
  // A change replaces a value, map and comments with it; add and move remove nothing.
  if (operation === 'add' || operation === 'move') {
    for (const [text, count] of had) {
      if ((has.get(text) ?? 0) < count) problems.push(`${text} lost`);
    }
  }
  return problems.length === 0
    ? []
    : [`${JSON.stringify(original)} ${JSON.stringify(changes)}: ${problems.join('; ')}`];
}

describe('keep-chomped block text survives every change (#739 property)', () => {
  const random = seeded(739);
  const cases = Array.from({ length: 1500 }, () => generated(random));

  it('reads back exactly as asked and writes no comment twice, or is refused', () => {
    const broken = cases.flatMap(problemsOf);
    expect(broken.slice(0, 5)).toEqual([]);
  });

  it('writes most changes rather than refusing them', () => {
    const refused = cases.filter(({ original, changes }) => {
      try {
        updateFrontmatter(original, changes);
        return false;
      } catch (error) {
        if (error instanceof FrontmatterRefusedError) return true;
        throw error;
      }
    });
    expect(refused.length).toBeLessThan(cases.length * 0.1);
  });
});
