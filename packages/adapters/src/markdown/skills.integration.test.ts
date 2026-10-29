/**
 * Skills through the real markdown port (ADR-0050, ADR-0003): a new skill is
 * written in its one canonical form and reads back as written, and an edit
 * rewrites only the frontmatter key that changed — comments, quoting, key
 * order and unknown keys stay byte for byte.
 */

import { describe, expect, it } from 'vitest';
import { apiFixture, createSkill, readSkill, saveSkill } from '@dfai/application';
import { remarkMarkdown } from './markdown-port.ts';

const PATH = '.atlas/skills/weekly-review/SKILL.md';

function vault(files: Record<string, string> = {}) {
  const fixture = apiFixture({
    files: { '.atlas/settings.md': '', ...files },
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

describe('a skill through the real markdown port', () => {
  it('writes a new skill canonically, quoting what YAML would misread, and reads it back', async () => {
    const { fixture, read } = vault();
    const draft = {
      name: 'weekly-review',
      description: 'Use when: Mara Quill asks for "the Friday review" # of projects.',
      instructions: 'Step one.\n\n- Step two.',
    };

    await createSkill({ fs: fixture.fs, markdown: remarkMarkdown, draft });

    const skill = await read();
    expect(skill).toMatchObject({
      declaredName: 'weekly-review',
      description: draft.description,
      instructions: 'Step one.\n\n- Step two.\n',
      problems: [],
    });
    expect(fixture.files.get(PATH)?.text).toMatch(
      /^---\nname: weekly-review\ndescription: .+\n---\n\nStep one\./,
    );
  });

  it('changes only the description line of a hand-written SKILL.md, keeping its quotes', async () => {
    const text =
      '---\n# written by hand\nname: weekly-review\ndescription: "Old words."\nlicense:   MIT\n' +
      'metadata:\n  owner: Tobias Fenn\n---\n\nStep one.\n\n\tKeep   this.\n';
    const { fixture, read } = vault({ [PATH]: text });
    const skill = await read();

    await saveSkill({
      fs: fixture.fs,
      markdown: remarkMarkdown,
      skill,
      draft: { name: skill.name, description: 'New words.', instructions: skill.instructions },
    });

    expect(fixture.files.get(PATH)?.text).toBe(text.replace('Old words.', 'New words.'));
  });

  it('writes an untouched hand-written SKILL.md back as it was, or not at all', async () => {
    const text =
      '---\nname: weekly-review   # mine\ndescription: >\n  Folded\n  words.\n---\nStep.\r\n';
    const { fixture, read } = vault({ [PATH]: text });
    const skill = await read();

    await saveSkill({
      fs: fixture.fs,
      markdown: remarkMarkdown,
      skill,
      draft: { name: skill.name, description: skill.description, instructions: skill.instructions },
    });

    expect(fixture.writes).toEqual([]);
    expect(fixture.files.get(PATH)?.text).toBe(text);
  });

  it('reports frontmatter the parser cannot read, and refuses to save over it', async () => {
    const text = '---\nname: [weekly\ndescription: x\n---\n\nStep.\n';
    const { fixture, read } = vault({ [PATH]: text });
    const skill = await read();

    expect(skill.problems[0]?.field).toBe('file');
    await expect(
      saveSkill({
        fs: fixture.fs,
        markdown: remarkMarkdown,
        skill,
        draft: { name: 'weekly-review', description: 'd', instructions: 'i' },
      }),
    ).rejects.toThrow(/cannot be read/);
    expect(fixture.files.get(PATH)?.text).toBe(text);
  });
});
