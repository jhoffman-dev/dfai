/**
 * Attack on PR #687 (#683), through the real YAML port: type files that still
 * define no type, or the wrong one, without being listed as broken.
 */
import { describe, expect, it } from 'vitest';
import { setTypeLabel } from '@dfai/domain';
import { apiFixture, loadTypeListing, saveObjectType } from '@dfai/application';
import { remarkMarkdown } from './markdown-port.ts';

async function listing(files: Record<string, string>) {
  const { fs } = apiFixture({ files, markdown: remarkMarkdown });
  return loadTypeListing({ fs, markdown: remarkMarkdown });
}

describe('type files the listing stays silent about (attack #687)', () => {
  it.fails('lists a type file whose keys are capitalised, Name: and Properties:', async () => {
    // A type by hand with the keys capitalised: none of a type's keys match, so
    // the file is taken for "not a type" — no type loads, and nothing says why.
    const path = '.atlas/types/Recipe.md';
    const text = [
      '---',
      'Name: recipe',
      'Label: Recipe',
      'Properties:',
      '  serves: number',
      '---',
      '',
    ];
    const read = await listing({ [path]: text.join('\n') });
    expect(read.types).toEqual([]);
    expect(read.broken.map((broken) => broken.path)).toEqual([path]);
  });

  it.fails(
    'does not load a type named by a map, as “[object Object]”, without saying so',
    async () => {
      const path = '.atlas/types/Film.md';
      const read = await listing({ [path]: '---\nname: {film: true}\nlabel: Film\n---\n' });
      // Observed: a type named "[object Object]" loads, and the file is not listed.
      expect(read.types.map((type) => type.name)).not.toContain('[object Object]');
      expect(read.broken.map((broken) => broken.path)).toEqual([path]);
    },
  );
});

describe('a type that turns broken while its editor is open (attack #687)', () => {
  it.fails(
    'an edit saved after the closing fence was deleted writes nothing over the file',
    async () => {
      const path = '.atlas/types/film.md';
      const valid = [
        '---',
        'name: film',
        'label: Film',
        'properties:',
        '  year: number',
        '---',
        '',
        '# Film',
        '',
      ];
      const fixture = apiFixture({ files: { [path]: valid.join('\n') }, markdown: remarkMarkdown });
      const before = (await loadTypeListing({ fs: fixture.fs, markdown: remarkMarkdown }))
        .types[0]!;
      // Meanwhile, in another editor, the closing fence is deleted: the sidebar now lists it broken.
      const unclosed = valid.filter((_, at) => at !== 5).join('\n');
      fixture.files.set(path, { text: unclosed, modified: 999 });
      // The type editor saves a label change as `use-type-editor` does: with no `ifModified`.
      const saving = saveObjectType({
        fs: fixture.fs,
        markdown: remarkMarkdown,
        path: before.path,
        before,
        type: setTypeLabel(before, 'Films'),
      });
      // A refusal is the right answer; swallowed here so the file is what is asserted.
      await saving.catch(() => undefined);
      // Observed: a second, name-less block goes on top, the unclosed one pushed into the body.
      expect(fixture.files.get(path)?.text).toBe(unclosed);
    },
  );
});
