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
      [PATH]: '---\n{"featuresOff":["reading"],"sidebarOrder":["views"]}\n---\n',
    });
    const settings = createSettingsWriter({ fs, markdown: jsonMarkdown() });
    await saveFeatureSwitch({ settings, id: 'reading', on: true });

    expect(written[PATH]).toContain('"featuresOff":[]');
    expect(written[PATH]).toContain('"sidebarOrder":["views"]');
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
