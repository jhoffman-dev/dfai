import { describe, expect, it } from 'vitest';
import { joinFrontmatter, splitFrontmatter } from '../markdown/markdown-document.ts';
import {
  bodyWithInstructions,
  isWrittenWithCrlf,
  skillDeletionWarning,
  instructionsOf,
  isSkillNameTaken,
  newSkillBody,
  skillReadingOf,
  skillDescriptionProblem,
  skillDraftProblems,
  skillFilePath,
  skillFolderNamed,
  skillFolderPath,
  skillFrontmatterChanges,
  skillInstructionsProblem,
  skillNameProblem,
} from './skill-rules.ts';

const DRAFT = {
  name: 'weekly-review',
  description: 'Walks Mara Quill through her Friday review of open projects.',
  instructions: 'List each project with no next action.\n',
};

describe('skillNameProblem', () => {
  it.each(['a', 'weekly-review', 'v2', 'a1-b2-c3', 'x'.repeat(64)])('takes %j', (name) => {
    expect(skillNameProblem(name)).toBeNull();
  });

  it('refuses an empty name', () => {
    expect(skillNameProblem('')).toMatch(/Name the skill/);
  });

  it('refuses a name longer than 64 characters', () => {
    expect(skillNameProblem('x'.repeat(65))).toMatch(/at most 64/);
  });

  it.each([
    'Weekly-review',
    'weekly review',
    'weekly_review',
    'wöchentlich',
    'weekly/review',
    '..',
    '-weekly',
    'weekly-',
    'weekly--review',
    '-',
  ])('refuses %j, which is not lowercase letters, digits and single hyphens', (name) => {
    expect(skillNameProblem(name)).toMatch(/lowercase letters, digits and single hyphens/);
  });

  it.each([
    ['claude', 'claude'],
    ['ask-claude-first', 'claude'],
    ['anthropic', 'anthropic'],
    ['my-anthropic-notes', 'anthropic'],
  ])('refuses %j, which holds a reserved word', (name, word) => {
    expect(skillNameProblem(name)).toBe(`A skill’s name cannot hold “${word}”.`);
  });
});

describe('skillDescriptionProblem', () => {
  it('takes a description of up to 1024 characters', () => {
    expect(skillDescriptionProblem('d'.repeat(1024))).toBeNull();
  });

  it.each(['', '   \n'])('refuses a blank description %j', (description) => {
    expect(skillDescriptionProblem(description)).toMatch(/Say what the skill does/);
  });

  it('refuses one longer than 1024 characters', () => {
    expect(skillDescriptionProblem('d'.repeat(1025))).toMatch(/at most 1024/);
  });

  it.each(['Use <example> blocks', 'ends </b>', 'a <br/> break', '<tag attr="1">'])(
    'refuses %j, which holds an XML tag',
    (description) => {
      expect(skillDescriptionProblem(description)).toMatch(/XML tags/);
    },
  );

  it.each(['when a < b > c', 'costs <5 minutes', 'arrows -> and <-'])(
    'takes %j, whose angle brackets are not a tag',
    (description) => {
      expect(skillDescriptionProblem(description)).toBeNull();
    },
  );
});

describe('skillInstructionsProblem', () => {
  it('takes instructions of up to 20,000 characters', () => {
    expect(skillInstructionsProblem('i'.repeat(20_000))).toBeNull();
  });

  it.each(['', '\n\n  '])('refuses blank instructions %j', (instructions) => {
    expect(skillInstructionsProblem(instructions)).toMatch(/Write the skill’s instructions/);
  });

  it('counts instructions in characters, so 20,000 emoji are allowed and 20,001 are not', () => {
    expect(skillInstructionsProblem('\u{1F600}'.repeat(20_000))).toBeNull();
    expect(skillInstructionsProblem('\u{1F600}'.repeat(20_001))).toMatch(/at most 20000/);
  });

  it('refuses instructions longer than 20,000 characters', () => {
    expect(skillInstructionsProblem('i'.repeat(20_001))).toMatch(/at most 20000/);
  });
});

describe('skillDraftProblems', () => {
  it('is empty for a draft that can be saved', () => {
    expect(skillDraftProblems(DRAFT)).toEqual([]);
  });

  it('names each field that is wrong', () => {
    const problems = skillDraftProblems({ name: 'Bad', description: '', instructions: ' ' });
    expect(problems.map(({ field }) => field)).toEqual(['name', 'description', 'instructions']);
  });
});

describe('duplicates', () => {
  it('finds a name taken in another case', () => {
    expect(isSkillNameTaken('weekly-review', ['Weekly-Review'])).toBe(true);
  });

  it('finds a name taken in a compatibility form (fullwidth letters)', () => {
    expect(isSkillNameTaken('weekly', ['ｗｅｅｋｌｙ'])).toBe(true);
  });

  it('finds a name taken in another Unicode normalisation', () => {
    expect(isSkillNameTaken('café', ['café'])).toBe(true);
  });

  it('does not find a name nobody has', () => {
    expect(isSkillNameTaken('weekly-review', ['weekly-reviews', 'daily'])).toBe(false);
  });

  it('looks a folder up by its exact name first, then in any case', () => {
    expect(skillFolderNamed('Daily', ['daily', 'Daily'])).toBe('Daily');
    expect(skillFolderNamed('DAILY', ['daily', 'Daily'])).toBe('daily');
    expect(skillFolderNamed('weekly', ['daily'])).toBeNull();
  });
});

describe('paths', () => {
  it('puts a skill in its own folder under .atlas/skills', () => {
    expect(skillFolderPath('weekly-review')).toBe('.atlas/skills/weekly-review');
    expect(skillFilePath('weekly-review')).toBe('.atlas/skills/weekly-review/SKILL.md');
  });
});

describe('skillReadingOf', () => {
  const file = (properties: Record<string, unknown>, body = '\nDo the thing.\n') => ({
    properties,
    body,
    frontmatterProblem: null,
  });

  it('reads a well-made skill with no problems', () => {
    const skill = skillReadingOf({
      folder: 'weekly-review',
      file: file({ name: 'weekly-review', description: DRAFT.description }),
    });
    expect(skill).toEqual({
      name: 'weekly-review',
      declaredName: 'weekly-review',
      description: DRAFT.description,
      instructions: 'Do the thing.',
      problems: [],
    });
  });

  it('takes its name from the folder and reports a name: that differs, without fixing it', () => {
    const skill = skillReadingOf({
      folder: 'weekly-review',
      file: file({ name: 'friday-review', description: 'Reviews.' }),
    });
    expect(skill.name).toBe('weekly-review');
    expect(skill.declaredName).toBe('friday-review');
    expect(skill.problems).toEqual([
      {
        field: 'name',
        message: 'SKILL.md names it “friday-review”, but its folder is “weekly-review”.',
      },
    ]);
  });

  it('reports a missing or non-text name:', () => {
    for (const properties of [{ description: 'x' }, { name: 42, description: 'x' }]) {
      const skill = skillReadingOf({ folder: 'daily', file: file(properties) });
      expect(skill.declaredName).toBeNull();
      expect(skill.problems).toEqual([
        { field: 'name', message: 'SKILL.md has no name; it should be “daily”.' },
      ]);
    }
  });

  it('reports a folder whose own name cannot be a skill’s', () => {
    const skill = skillReadingOf({
      folder: 'Claude Notes',
      file: file({ name: 'Claude Notes', description: 'x' }),
    });
    expect(skill.problems.map(({ field }) => field)).toEqual(['name']);
    expect(skill.problems[0]?.message).toMatch(/^Its folder: /);
  });

  it('reports a missing description and empty instructions', () => {
    const skill = skillReadingOf({ folder: 'daily', file: file({ name: 'daily' }, '\n') });
    expect(skill.problems.map(({ field }) => field)).toEqual(['description', 'instructions']);
  });

  it('reports a folder with no SKILL.md', () => {
    const skill = skillReadingOf({ folder: 'daily', file: null });
    expect(skill.problems).toEqual([{ field: 'file', message: 'The folder has no SKILL.md.' }]);
  });

  it('reports frontmatter that cannot be read', () => {
    const skill = skillReadingOf({
      folder: 'daily',
      file: { properties: {}, body: '\nx\n', frontmatterProblem: 'Bad YAML on line 2.' },
    });
    expect(skill.problems[0]).toEqual({ field: 'file', message: 'Bad YAML on line 2.' });
  });
});

describe('instructions and the body', () => {
  it('reads the instructions between the blank line and the last line’s ending', () => {
    expect(instructionsOf('\nStep one.\n')).toBe('Step one.');
    expect(instructionsOf('\r\nStep one.\r\n')).toBe('Step one.');
    expect(instructionsOf('Step one.')).toBe('Step one.');
    expect(instructionsOf('\nStep one.\n\n')).toBe('Step one.\n');
  });

  it('keeps the body byte for byte when the instructions did not change', () => {
    const body = '\r\nStep one.\r\n\r\n  - keep   this spacing\r\n';
    expect(bodyWithInstructions(body, instructionsOf(body))).toBe(body);
  });

  it('writes changed instructions with the CRLF line ends the body already had', () => {
    expect(bodyWithInstructions('\r\nOld.\r\nTwo.\r\n', 'New.\nTwo.')).toBe('\r\nNew.\r\nTwo.\r\n');
    expect(bodyWithInstructions('\nOld.\n', 'New.\r\nTwo.')).toBe('\nNew.\r\nTwo.\r\n');
  });

  it('looks at the whole file for CRLF, not the body alone', () => {
    const file = '---\r\nname: daily\r\ndescription: d\r\n---\r\nOld.\n';
    expect(bodyWithInstructions('Old.\n', 'New.\nTwo.', file)).toBe('New.\r\nTwo.\r\n');
    expect(
      bodyWithInstructions('\r\nOld.\r\n', 'New.', '---\nname: a\nb: c\nd: e\n---\r\nOld.\r\n'),
    ).toBe('\r\nNew.\n');
  });

  it('keeps the blank line the body had when the instructions change', () => {
    expect(bodyWithInstructions('\r\nOld.\r\n', 'New.')).toBe('\r\nNew.\r\n');
    expect(bodyWithInstructions('Old.\n', 'New.')).toBe('New.\n');
  });

  it('writes a new skill’s body in one form: a blank line, the instructions, one line ending', () => {
    expect(newSkillBody('Step one.')).toBe('\nStep one.\n');
  });

  it.each(['Step one.', 'Step one.\n', 'a\n\nb', ''])(
    'reads back exactly what it wrote, %j, new or changed',
    (instructions) => {
      expect(instructionsOf(newSkillBody(instructions))).toBe(instructions);
      expect(instructionsOf(bodyWithInstructions('\nOld.\n', instructions))).toBe(instructions);
      const crlf = bodyWithInstructions('\r\nOld.\r\n', instructions);
      expect(instructionsOf(crlf).replace(/\r\n/g, '\n')).toBe(instructions);
    },
  );
});

describe('skillFrontmatterChanges', () => {
  const before = { declaredName: 'daily', description: 'Plans the day.' };

  it('changes nothing when nothing changed', () => {
    expect(
      skillFrontmatterChanges(before, { name: 'daily', description: 'Plans the day.' }),
    ).toEqual({});
  });

  it('changes only the key that changed', () => {
    expect(skillFrontmatterChanges(before, { name: 'daily', description: 'Plans it.' })).toEqual({
      description: 'Plans it.',
    });
    expect(
      skillFrontmatterChanges(
        { declaredName: 'other', description: 'Plans the day.' },
        { name: 'daily', description: 'Plans the day.' },
      ),
    ).toEqual({ name: 'daily' });
  });
});

describe('a parse→edit round trip', () => {
  const TEXT =
    '---\n# kept comment\nname: daily\ndescription: "Plans the day."\nlicense: MIT\n---\n\n' +
    'Step one.\n\n\tTabbed   line.  \n';

  const reread = (text: string) => {
    const { frontmatter, body } = splitFrontmatter(text);
    const properties = { name: 'daily', description: 'Plans the day.' };
    return {
      frontmatter,
      body,
      skill: skillReadingOf({
        folder: 'daily',
        file: { properties, body, frontmatterProblem: null },
      }),
    };
  };

  it('writes an untouched skill back byte for byte', () => {
    const { frontmatter, body, skill } = reread(TEXT);
    const changes = skillFrontmatterChanges(skill, {
      name: skill.name,
      description: skill.description,
    });
    expect(changes).toEqual({});
    expect(joinFrontmatter(frontmatter, bodyWithInstructions(body, skill.instructions))).toBe(TEXT);
  });

  it('changes only the body, leaving every frontmatter byte, when only the instructions change', () => {
    const { frontmatter, body } = reread(TEXT);
    const edited = joinFrontmatter(frontmatter, bodyWithInstructions(body, 'Step two.'));
    expect(edited).toBe(`${frontmatter ?? ''}\nStep two.\n`);
    expect(splitFrontmatter(edited).frontmatter).toBe(frontmatter);
  });
});

describe('skillDeletionWarning', () => {
  it('says the whole folder goes, naming its other files and that deeper ones go too', () => {
    expect(
      skillDeletionWarning('weekly-review', [
        '.atlas/skills/weekly-review/reference.md',
        '.atlas/skills/weekly-review/scripts/run.sh',
      ]),
    ).toBe(
      'Delete “weekly-review”? Its whole folder goes to the Trash, where it can be got back, ' +
        'with 2 other files: reference.md, scripts/run.sh — and everything in its subfolders, ' +
        'however deep.',
    );
  });

  it('says only SKILL.md goes when the folder holds nothing else', () => {
    expect(skillDeletionWarning('daily', [])).toBe(
      'Delete “daily”? Its folder, holding only SKILL.md, goes to the Trash, where it can be got back.',
    );
  });
});

describe('isWrittenWithCrlf', () => {
  it('is whether most line ends are CRLF', () => {
    expect(isWrittenWithCrlf('a\r\nb\r\nc\n')).toBe(true);
    expect(isWrittenWithCrlf('a\r\nb\nc\n')).toBe(false);
    expect(isWrittenWithCrlf('no line end')).toBe(false);
  });
});
