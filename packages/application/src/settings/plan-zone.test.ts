import { describe, expect, it } from 'vitest';
import { jsonMarkdown, vaultWith } from '../testing/settings-vault.ts';
import { readPlanZone } from './plan-zone.ts';

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
