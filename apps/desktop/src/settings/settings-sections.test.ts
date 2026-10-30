import { describe, expect, it } from 'vitest';
import { settingsSectionLinks } from './settings-sections.ts';

/** The list on the left of Settings, as `app.tsx` draws the sections (UI v2 slice 13f). */
describe('settingsSectionLinks', () => {
  it('names every section, in the order the app draws them, with a vault open', () => {
    expect(settingsSectionLinks({ vaultOpen: true }).map((section) => section.title)).toEqual([
      'Profile',
      'Index',
      'Images',
      'Quick capture from anywhere',
      'Quick add',
      'Secrets',
      'Google Calendar',
      'Granola',
      'Slack',
      'Kindle',
      'Claude',
      'Sync',
      'About',
    ]);
  });

  it('leaves out the sections that want a vault, before one is open', () => {
    expect(settingsSectionLinks({ vaultOpen: false }).map((section) => section.title)).toEqual([
      'Index',
      'Images',
      'Quick capture from anywhere',
      'Claude',
      'About',
    ]);
  });

  it('links each row to a heading of its own', () => {
    const ids = settingsSectionLinks({ vaultOpen: true }).map((section) => section.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
