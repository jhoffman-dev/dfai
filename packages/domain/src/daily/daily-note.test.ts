import { describe, expect, it } from 'vitest';
import { isBuiltInType, typeDeleteRefusal } from '../types/built-in-types.ts';
import type { ObjectType } from '../types/property-def.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import { DAILY_TYPE_FILE, dailyNoteAmong, dailyTypeToOffer } from './daily-note.ts';

/** #81: today's note is a note of the built-in Daily type. */
const typeNamed = (name: string): ObjectType => ({ name, label: name, properties: [] });

describe('the Daily type', () => {
  it('is offered to a vault without one', () => {
    expect(dailyTypeToOffer([typeNamed('task'), typeNamed('project')])).toBe(DAILY_TYPE_FILE);
    expect(dailyTypeToOffer([])).toBe(DAILY_TYPE_FILE);
  });

  it('is not offered to a vault that has one, in any case', () => {
    expect(dailyTypeToOffer([typeNamed('task'), typeNamed('daily')])).toBeNull();
    expect(dailyTypeToOffer([typeNamed(' Daily ')])).toBeNull();
  });

  it('is built in, so it cannot be deleted, and says why', () => {
    expect(isBuiltInType('daily')).toBe(true);
    expect(typeDeleteRefusal({ name: 'daily', label: 'Daily' })).toMatch(
      /^Daily is built in — today's note is a note of it —/,
    );
  });

  it('is named daily, as notes imported with `type: daily` already say', () => {
    expect(DAILY_TYPE_FILE.type).toMatchObject({ name: 'daily', label: 'Daily' });
  });

  it('types the day and the tags the Notion import writes on a daily note', () => {
    expect(DAILY_TYPE_FILE.type.properties.map(({ key, kind }) => [key, kind])).toEqual([
      ['date', 'date'],
      ['tags', 'multiSelect'],
    ]);
  });
});

describe("the vault's note for today", () => {
  const paths = (...names: string[]) => names.map((name) => createVaultPath(name));

  it('is `<date>.md` at the root', () => {
    expect(dailyNoteAmong('2026-10-12', paths('Garden.md', '2026-10-12.md'))).toBe('2026-10-12.md');
  });

  it('is found however the disk spells its name: .MD, .markdown, in any case', () => {
    for (const name of ['2026-10-12.MD', '2026-10-12.markdown', '2026-10-12.Markdown']) {
      expect(dailyNoteAmong('2026-10-12', paths('Garden.md', name)), name).toBe(name);
    }
  });

  it('prefers `<date>.md` over another spelling of the same day', () => {
    expect(dailyNoteAmong('2026-10-12', paths('2026-10-12.MD', '2026-10-12.md'))).toBe(
      '2026-10-12.md',
    );
  });

  it('is never a note in a folder, another day, or a file that is not a note', () => {
    expect(
      dailyNoteAmong(
        '2026-10-12',
        paths('Journal/2026-10-12.md', '2026-10-11.md', '2026-10-12.txt', '2026-10-12 1.md'),
      ),
    ).toBeNull();
  });
});
