import { describe, expect, it } from 'vitest';
import { createSettingsWriter } from '../settings/index.ts';
import { jsonMarkdown, vaultWith } from '../testing/settings-vault.ts';
import { featuresOffOf, saveFeatureSwitch } from './features-off.ts';

const PATH = '.atlas/settings.md';

describe('featuresOffOf', () => {
  it('reads nothing off when the settings do not mention features', () => {
    expect(featuresOffOf({ quickAdd: ['task'] })).toEqual([]);
  });

  it('reads the listed features through the domain rules', () => {
    expect(featuresOffOf({ featuresOff: ['reading', 'someday', 'reading'] })).toEqual(['reading']);
  });

  it('answers the same frozen array for the same content, read after read', () => {
    expect(featuresOffOf({})).toBe(featuresOffOf({ featuresOff: 'reading' }));
    expect(Object.isFrozen(featuresOffOf({}))).toBe(true);
    const off = featuresOffOf({ featuresOff: ['reading'] });
    expect(featuresOffOf({ featuresOff: ['someday', 'reading'] })).toBe(off);
    expect(Object.isFrozen(off)).toBe(true);
  });
});

describe('saveFeatureSwitch', () => {
  it('writes a feature switched off beside the other settings, keeping them and the words', async () => {
    const { fs, written } = vaultWith({
      [PATH]: '---\n{"quickAdd":["task"]}\n---\n\nMy notes.\n',
    });
    const settings = createSettingsWriter({ fs, markdown: jsonMarkdown() });
    await saveFeatureSwitch({ settings, id: 'reading', on: false });

    expect(written[PATH]).toContain('"quickAdd":["task"]');
    expect(written[PATH]).toContain('"featuresOff":["reading"]');
    expect(written[PATH]).toContain('My notes.');
  });

  it('takes a feature switched on back out of the list, keeping ids it does not know', async () => {
    const { fs, written } = vaultWith({
      [PATH]: '---\n{"featuresOff":["later","reading","someday"],"sidebarOrder":["views"]}\n---\n',
    });
    const settings = createSettingsWriter({ fs, markdown: jsonMarkdown() });
    await saveFeatureSwitch({ settings, id: 'reading', on: true });

    expect(written[PATH]).toContain('"featuresOff":["later","someday"]');
    expect(written[PATH]).toContain('"sidebarOrder":["views"]');
  });

  it('keeps every entry it does not change, those that are not ids among them', async () => {
    const { fs, written } = vaultWith({
      [PATH]: '---\n{"featuresOff":[7,"reading",null,{"by":"hand"},"later"]}\n---\n',
    });
    const settings = createSettingsWriter({ fs, markdown: jsonMarkdown() });
    await saveFeatureSwitch({ settings, id: 'reading', on: true });
    expect(written[PATH]).toContain('"featuresOff":[7,null,{"by":"hand"},"later"]');

    await saveFeatureSwitch({ settings, id: 'graph', on: false });
    expect(written[PATH]).toContain('"featuresOff":[7,null,{"by":"hand"},"later","graph"]');
  });

  it('writes Reading alone when Reading is switched off: Kindle, held off by it, is not written', async () => {
    const { fs, written } = vaultWith({ [PATH]: '---\n{}\n---\n' });
    const settings = createSettingsWriter({ fs, markdown: jsonMarkdown() });
    await saveFeatureSwitch({ settings, id: 'reading', on: false });
    expect(written[PATH]).toContain('"featuresOff":["reading"]');

    await saveFeatureSwitch({ settings, id: 'reading', on: true });
    expect(written[PATH]).toContain('"featuresOff":[]');
  });

  it('replaces a value that is not a list with a list of only what was just chosen', async () => {
    for (const [on, expected] of [
      [false, '"featuresOff":["reading"]'],
      [true, '"featuresOff":[]'],
    ] as const) {
      const { fs, written } = vaultWith({
        [PATH]: '---\n{"featuresOff":"reading, someday"}\n---\n',
      });
      const settings = createSettingsWriter({ fs, markdown: jsonMarkdown() });
      await saveFeatureSwitch({ settings, id: 'reading', on });
      expect(written[PATH]).toContain(expected);
    }
  });

  it('makes the settings file when there is none', async () => {
    const { fs, written, created } = vaultWith({});
    const settings = createSettingsWriter({ fs, markdown: jsonMarkdown() });
    await saveFeatureSwitch({ settings, id: 'reading', on: false });

    expect(created).toContain(PATH);
    expect(written[PATH]).toContain('"featuresOff":["reading"]');
  });

  it('passes on a write the host refuses', async () => {
    const { fs } = vaultWith({ [PATH]: '---\n{}\n---\n' });
    const refusing = { ...fs, writeTextFile: () => Promise.reject(new Error('read-only')) };
    await expect(
      saveFeatureSwitch({
        settings: createSettingsWriter({ fs: refusing, markdown: jsonMarkdown() }),
        id: 'reading',
        on: false,
      }),
    ).rejects.toThrow('read-only');
  });
});
