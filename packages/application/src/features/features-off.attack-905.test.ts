import { describe, expect, it } from 'vitest';
import { createSettingsWriter } from '../settings/index.ts';
import { jsonMarkdown, vaultWith } from '../testing/settings-vault.ts';
import { saveFeatureSwitch } from './features-off.ts';

const PATH = '.atlas/settings.md';

function featuresOffIn(text: string | undefined): unknown {
  const match = /\n(\{.*\})\n/.exec(text ?? '');
  return (JSON.parse(match?.[1] ?? '{}') as Record<string, unknown>).featuresOff;
}

describe('saveFeatureSwitch keeps what a newer version switched off', () => {
  it('keeps an unknown id in the file after Reading is switched on', async () => {
    const { fs, written } = vaultWith({
      [PATH]: '---\n{"featuresOff":["reading","somethingNew"]}\n---\n',
    });
    const settings = createSettingsWriter({ fs, markdown: jsonMarkdown() });
    await saveFeatureSwitch({ settings, id: 'reading', on: true });

    expect(featuresOffIn(written[PATH])).toEqual(['somethingNew']);
  });

  it('keeps an unknown id in the file after Reading is switched off', async () => {
    const { fs, written } = vaultWith({
      [PATH]: '---\n{"featuresOff":["somethingNew"]}\n---\n',
    });
    const settings = createSettingsWriter({ fs, markdown: jsonMarkdown() });
    await saveFeatureSwitch({ settings, id: 'reading', on: false });

    expect(featuresOffIn(written[PATH])).toEqual(['somethingNew', 'reading']);
  });
});
