import { describe, expect, it } from 'vitest';
import { jsonMarkdown, vaultWith } from '../testing/settings-vault.ts';
import { createSettingsWriter } from './settings-writer.ts';
import { readPlanZone, tryKeepPlanZone } from './plan-zone.ts';

const SETTINGS = '.atlas/settings.md';

describe('readPlanZone', () => {
  it('is the zone the settings keep, or null when they keep none', async () => {
    const kept = vaultWith({ [SETTINGS]: '---\n{"google_plan_zone":"America/Chicago"}\n---\n' });
    expect(await readPlanZone({ fs: kept.fs, markdown: jsonMarkdown() })).toBe('America/Chicago');
    const none = vaultWith({});
    expect(await readPlanZone({ fs: none.fs, markdown: jsonMarkdown() })).toBeNull();
  });

  it('reads none from a settings note that cannot be read: the Mac’s zone is used then', async () => {
    const { fs } = vaultWith({ [SETTINGS]: '---\n{not json\n---\n' });
    expect(await readPlanZone({ fs, markdown: jsonMarkdown() })).toBeNull();
  });

  it('lets a failure that is not the note’s own rise', async () => {
    const fs = { readNotes: async () => Promise.reject(new Error('the disk went away')) };
    await expect(readPlanZone({ fs, markdown: jsonMarkdown() })).rejects.toThrow('disk went away');
  });
});

describe('tryKeepPlanZone', () => {
  const keep = (fs: ReturnType<typeof vaultWith>['fs']) => {
    const markdown = jsonMarkdown();
    return tryKeepPlanZone({
      fs,
      markdown,
      settings: createSettingsWriter({ fs, markdown }),
      learned: 'America/Chicago',
      from: 'meetings',
    });
  };

  it('is null once the zone is kept, and null again when there was nothing to write', async () => {
    const { fs, written } = vaultWith({ [SETTINGS]: '---\n{}\n---\n' });
    expect(await keep(fs)).toBeNull();
    expect(written[SETTINGS]).toContain('America/Chicago');
    expect(await keep(fs)).toBeNull();
  });

  it('says why a settings note refused it, naming no path on the Mac', async () => {
    const { fs } = vaultWith({});
    fs.readNotes = async () =>
      Promise.reject(new Error('EACCES: /Users/mara/Vault/.atlas/settings.md'));
    const problem = await keep(fs);
    expect(problem).toContain('EACCES');
    expect(problem).not.toContain('/Users/mara');
  });

  it('lets a fault in DFAI’s own code rise rather than be reported as a refusal', async () => {
    const { fs } = vaultWith({});
    fs.readNotes = async () => Promise.reject(new TypeError('paths is not iterable'));
    await expect(keep(fs)).rejects.toThrow(TypeError);
  });
});
