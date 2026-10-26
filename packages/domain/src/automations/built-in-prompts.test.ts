import { describe, expect, it } from 'vitest';
import { splitFrontmatter } from '../markdown/markdown-document.ts';
import { draftProblem } from './automation-rule.ts';
import {
  AFTER_A_MEETING_PROMPT,
  BUILT_IN_PROMPTS,
  builtInPromptAt,
  MEETING_EXTRACTION_PROMPT,
  outdatedBuiltInPrompt,
  promptDigest,
} from './built-in-prompts.ts';
import {
  EARLIER_AFTER_A_MEETING,
  EARLIER_MEETING_EXTRACTION,
} from './built-in-prompts.earlier.fixture.ts';
import { isPromptPath } from './claude-step.ts';
import { AUTOMATION_PRESETS } from './presets.ts';
import { proposalSchemaNamed } from './proposal-schemas.ts';

/** P29-05: the prompt DFAI ships for meeting extraction, and the ready-made rule that names it. */
describe('the prompts DFAI ships', () => {
  it('are prompt notes a rule can name, each with words to ask', () => {
    expect(BUILT_IN_PROMPTS.map((prompt) => prompt.path)).toEqual([
      '.atlas/prompts/meeting-extraction.md',
      '.atlas/prompts/after-a-meeting.md',
      '.atlas/prompts/friday-review.md',
      '.atlas/prompts/morning-brief.md',
    ]);
    for (const prompt of BUILT_IN_PROMPTS) {
      expect(isPromptPath(prompt.path)).toBe(true);
      // What a step is asked is the note's body: it must not be read as empty.
      expect(splitFrontmatter(prompt.contents).body.trim()).toBe(prompt.contents.trim());
      expect(builtInPromptAt(prompt.path)).toBe(prompt);
    }
    expect(builtInPromptAt('.atlas/prompts/mine.md')).toBeNull();
  });

  it('tells meeting extraction the rules its output cannot check for it', () => {
    const { contents } = builtInPromptAt(MEETING_EXTRACTION_PROMPT)!;

    for (const rule of [
      'Only real commitments.',
      'written **You** in the transcript',
      'Do not guess a person.',
      'Cite one turn.',
      'hints, not a source',
      'Confidence means how sure you are',
    ]) {
      expect(contents).toContain(rule);
    }
  });
});

describe('the ready-made meeting extraction rule', () => {
  const preset = AUTOMATION_PRESETS.find((each) => each.action.kind === 'claude')!;

  it('is a whole rule: set off by a new meeting, asking the shipped prompt for meeting-items', () => {
    expect(draftProblem(preset)).toBeNull();
    expect(preset.when).toEqual({ kind: 'note', type: 'meeting', on: ['created'] });
    expect(preset.action).toEqual({
      kind: 'claude',
      prompt: MEETING_EXTRACTION_PROMPT,
      tools: [],
      output: { kind: 'proposals', schema: 'meeting-items' },
    });
    expect(proposalSchemaNamed('meeting-items')).not.toBeNull();
  });
});

/** #226: only the owner's real commitments, so the prompts say what is not one. */
describe('the prompts after #226', () => {
  const after = builtInPromptAt(AFTER_A_MEETING_PROMPT)!.contents;
  const extraction = builtInPromptAt(MEETING_EXTRACTION_PROMPT)!.contents;

  it.each([
    ['After a meeting', after],
    ['Meeting extraction', extraction],
  ])('%s gives counter-examples of what is not an item', (_, contents) => {
    expect(contents).toContain('## Not items');
    for (const kind of [
      'work under way',
      'an idea nobody took on',
      'a maybe',
      'a question',
      'how things work, not a decision',
      'small talk',
    ]) {
      expect(contents).toContain(kind);
    }
    expect(contents).toContain('A decision needs an agreement.');
    expect(contents).toContain('"asked_by_owner": true');
  });

  it('tells After a meeting that only high becomes a task, and not to list others’ own work', () => {
    const words = after.replace(/\s+/g, ' ');
    expect(words).toContain('Only "high" may become a task.');
    expect(words).toContain(
      "Another person's own work that the owner did not ask for is not listed at all.",
    );
    expect(words).toContain('a decision the owner took no part in');
  });

  it('uses only made-up names in its examples', () => {
    const names = [...after.matchAll(/\b[A-Z][a-z]+ [A-Z][a-z]+\b/g)].map(([name]) => name);
    for (const name of names) {
      expect([
        'Mara Quill',
        'Tobias Fenn',
        'Larkspur Payroll',
        'Remote Speaker',
        'Speaker 2',
      ]).toContain(name);
    }
  });
});

describe('bringing an untouched prompt up to date (#226)', () => {
  it.each([
    [MEETING_EXTRACTION_PROMPT, EARLIER_MEETING_EXTRACTION],
    [AFTER_A_MEETING_PROMPT, EARLIER_AFTER_A_MEETING],
  ])('knows the words %s shipped with before', (path, earlier) => {
    expect(outdatedBuiltInPrompt(path, earlier)).toBe(builtInPromptAt(path));
  });

  it('knows the words each shipped with while the app was called Atlas (ADR-0042)', () => {
    // The Friday review's (#40) came after the rename: it has no words from then.
    const beforeRename = BUILT_IN_PROMPTS.filter((prompt) => prompt.earlier.length > 0);
    expect(beforeRename.map((prompt) => prompt.path)).toEqual([
      MEETING_EXTRACTION_PROMPT,
      AFTER_A_MEETING_PROMPT,
    ]);
    for (const prompt of beforeRename) {
      expect(prompt.contents).toContain('DFAI');
      const asAtlasWroteIt = prompt.contents.replaceAll('DFAI', 'Atlas');
      expect(outdatedBuiltInPrompt(prompt.path, asAtlasWroteIt)).toBe(prompt);
    }
  });

  it('leaves the words it ships now, and any edit, as they are', () => {
    for (const prompt of BUILT_IN_PROMPTS) {
      expect(outdatedBuiltInPrompt(prompt.path, prompt.contents)).toBeNull();
    }
    expect(
      outdatedBuiltInPrompt(AFTER_A_MEETING_PROMPT, `${EARLIER_AFTER_A_MEETING}\nMine.`),
    ).toBeNull();
    expect(
      outdatedBuiltInPrompt(
        AFTER_A_MEETING_PROMPT,
        EARLIER_AFTER_A_MEETING.replace('Read', 'read'),
      ),
    ).toBeNull();
  });

  it('never takes another prompt’s earlier words, or a prompt it does not ship, for its own', () => {
    expect(outdatedBuiltInPrompt(AFTER_A_MEETING_PROMPT, EARLIER_MEETING_EXTRACTION)).toBeNull();
    expect(outdatedBuiltInPrompt('.atlas/prompts/mine.md', EARLIER_AFTER_A_MEETING)).toBeNull();
  });

  it('knows words by two digests and a length', () => {
    expect(promptDigest('abc')).toMatch(/^[0-9a-f]{16}-3$/);
    expect(promptDigest('abc')).not.toBe(promptDigest('abd'));
  });
});
