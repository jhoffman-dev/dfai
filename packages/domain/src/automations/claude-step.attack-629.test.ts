import { describe, expect, it } from 'vitest';
import { MAX_PROMPT_CHARACTERS } from '../chat/index.ts';
import { skillFilePath, skillNameProblem, skillReadingOf } from '../skills/index.ts';
import {
  isPromptPath,
  readClaudeAction,
  skillRunProblem,
  type ClaudeAction,
} from './claude-step.ts';

/**
 * Attack on PR #629 (#169, skills 3/5): a rule's `skill:` is exclusive with
 * `prompt:`, read against an oracle written from ADR-0050 and the PR's brief
 * rather than from the code; and a skill's instructions are held to the
 * prompt note's `.length` cap, the Skills page's code-point rule passing
 * only what the run's rule might still refuse — never the other way round.
 */

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

const BASE = { do: 'claude', tools: ['atlas_read_note'], output: 'proposals' };
const PROMPT = '.atlas/prompts/meeting-actions.md';
const NAME_ONE = 'Name one: prompt: .atlas/prompts/<name>.md, or skill: <name>, not both.';
const NAME_PROMPT = 'Name its prompt: prompt: .atlas/prompts/<name>.md.';
const ONE_NAME = 'Write skill: as one skill’s name, like skill: weekly-notes.';

/** Nothing written, as a file that leaves the key out reads: the oracle's one meaning of blank. */
const blank = (value: unknown) =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

/** What ADR-0050 says the step reads as, from its frontmatter alone. */
function oracle(frontmatter: Record<string, unknown>): { skill?: string; prompt: string } | string {
  const skill = frontmatter['skill'];
  const prompt = frontmatter['prompt'];
  if (blank(skill)) {
    const written = typeof prompt === 'string' ? prompt.trim() : '';
    return written !== '' && isPromptPath(written) ? { prompt: written } : NAME_PROMPT;
  }
  if (!blank(prompt)) return NAME_ONE;
  // An all-digit name YAML read as a number is told to be quoted (#629 attack, as fixed).
  if (typeof skill === 'number' && Number.isSafeInteger(skill) && skill >= 0) {
    return `Write skill: in quotes when its name is only digits, like skill: "${skill}".`;
  }
  if (typeof skill !== 'string') return ONE_NAME;
  const name = skill.trim();
  const problem = skillNameProblem(name);
  return problem === null ? { prompt: skillFilePath(name), skill: name } : `skill: ${problem}`;
}

const asRead = (action: ClaudeAction | string) =>
  typeof action === 'string'
    ? action
    : { prompt: action.prompt, ...(action.skill !== undefined && { skill: action.skill }) };

// Every value a YAML parse can hand over, empty lists aside (pinned on their own below).
const SKILLS: readonly unknown[] = [
  undefined,
  null,
  '',
  '   ',
  '\t',
  'weekly-notes',
  '  weekly-notes  ',
  'weekly-notes\n',
  'Weekly-Notes',
  'ｗeekly-notes',
  'weekly--notes',
  '../weekly-notes',
  'weekly-notes/SKILL.md',
  'a'.repeat(64),
  'a'.repeat(65),
  'claude-helper',
  '\u0000',
  '😀',
  0,
  42,
  -1,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  true,
  false,
  ['weekly-notes'],
  ['weekly-notes', 'other'],
  { name: 'weekly-notes' },
];
const PROMPTS: readonly unknown[] = [
  undefined,
  null,
  '',
  '  ',
  PROMPT,
  ` ${PROMPT} `,
  '.atlas/prompts/sub/x.md',
  '.atlas/skills/weekly-notes/SKILL.md',
  0,
  true,
  false,
  [PROMPT],
];
// Keys that are not `skill` or `prompt`, in another case: as for every other key, they change nothing.
const DECOYS: readonly Record<string, unknown>[] = [
  {},
  { Skill: 'weekly-notes' },
  { SKILL: 'weekly-notes' },
  { Prompt: PROMPT },
  { 'skill ': 'weekly-notes' },
];

describe('a Claude step’s skill or prompt, against an oracle (#629 attack)', () => {
  it('reads every seeded mix of skill:, prompt: and look-alike keys as ADR-0050 says', () => {
    const random = seeded(20261028);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const mismatches: string[] = [];
    for (let round = 0; round < 3000; round += 1) {
      const frontmatter: Record<string, unknown> = { ...BASE, ...pick(DECOYS) };
      const skill = pick(SKILLS);
      const prompt = pick(PROMPTS);
      if (skill !== undefined) frontmatter['skill'] = skill;
      if (prompt !== undefined) frontmatter['prompt'] = prompt;
      const got = asRead(readClaudeAction(frontmatter));
      const want = oracle(frontmatter);
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        mismatches.push(`${JSON.stringify(frontmatter)}: ${JSON.stringify(got)}`);
      }
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
  });

  it('never reads a step that writes both a skill and a prompt as either', () => {
    for (const skill of SKILLS.filter((value) => !blank(value))) {
      for (const prompt of PROMPTS.filter((value) => !blank(value))) {
        expect(readClaudeAction({ ...BASE, skill, prompt })).toBe(NAME_ONE);
      }
    }
  });

  it('refuses an empty list under skill: as it refuses any list, never taking it as no skill', () => {
    // `skill: [weekly-notes]` is refused as "not one name"; `skill: []` beside a prompt runs the prompt.
    for (const skill of [[], [''], ['  ']]) {
      expect(readClaudeAction({ ...BASE, skill, prompt: PROMPT })).toBe(NAME_ONE);
      expect(readClaudeAction({ ...BASE, skill })).toBe(ONE_NAME);
    }
  });

  it('reads an unquoted all-digit skill name as that skill, or says to quote it', () => {
    // `123` is a name skillNameProblem allows, and YAML hands `skill: 123` over as a number,
    // as it does `id: 123` — which a rule's id reads as "123".
    expect(skillNameProblem('123')).toBeNull();
    const read = readClaudeAction({ ...BASE, skill: 123 });
    if (typeof read === 'string') {
      expect(read).toMatch(/quot/i);
    } else {
      expect(read.skill).toBe('123');
    }
  });
});

const reading = (instructions: string) =>
  skillReadingOf({
    folder: 'weekly-notes',
    file: {
      properties: { name: 'weekly-notes', description: 'Writes the week’s notes.' },
      body: `\n${instructions}\n`,
      frontmatterProblem: null,
    },
  });

describe('a skill’s length, as the page and the run each count it (#629 attack)', () => {
  const ASTRAL = '😀';

  it.each([
    ['19,999 units', 'a'.repeat(19_999), null],
    ['20,000 units', 'a'.repeat(20_000), null],
    ['20,001 units', 'a'.repeat(20_001), 'problems'],
    ['an emoji ending at 20,000', `${'a'.repeat(19_998)}${ASTRAL}`, null],
    ['an emoji straddling 20,000', `${'a'.repeat(19_999)}${ASTRAL}`, 'too-long'],
    ['an emoji starting at 20,001', `${'a'.repeat(20_000)}${ASTRAL}`, 'problems'],
    ['10,000 emoji', ASTRAL.repeat(10_000), null],
    ['10,001 emoji', ASTRAL.repeat(10_001), 'too-long'],
  ] as const)('runs or refuses %s as the cap says', (_label, instructions, kind) => {
    expect(skillRunProblem(reading(instructions))?.kind ?? null).toBe(kind);
  });

  it('names the length and the cap when it is too long to run', () => {
    const problem = skillRunProblem(reading(`${'a'.repeat(19_999)}${ASTRAL}`));
    expect(problem?.message).toContain('20001');
    expect(problem?.message).toContain(String(MAX_PROMPT_CHARACTERS));
  });

  it('never runs a skill the page refuses, over seeded lengths around the cap', () => {
    const random = seeded(169629);
    const parts = ['a', ASTRAL, ' ', '\n', '\r\n', 'é', '́'];
    for (let round = 0; round < 400; round += 1) {
      let text = 'x';
      const target = 19_980 + Math.floor(random() * 40);
      while (text.length < target) text += parts[Math.floor(random() * parts.length)];
      const skill = reading(text);
      const run = skillRunProblem(skill);
      if (skill.problems.length > 0) expect(run).not.toBeNull();
      if (run?.kind === 'too-long')
        expect(text.trim().length).toBeGreaterThan(MAX_PROMPT_CHARACTERS);
      if (run === null) expect(text.trim().length).toBeLessThanOrEqual(MAX_PROMPT_CHARACTERS);
    }
  });
});
