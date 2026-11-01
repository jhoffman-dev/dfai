import { describe, expect, it } from 'vitest';
import { entryPointsOffered, EVERY_ENTRY_POINT } from '@dfai/application';
import {
  DESKTOP_CAPABILITIES,
  PLATFORM_CAPABILITIES,
  WEB_CAPABILITIES,
  type PlatformCapabilities,
  type PlatformCapability,
} from '@dfai/domain';
import { settingsSectionsShown } from './settings-sections.ts';

const titles = (offered: ReturnType<typeof entryPointsOffered>, vaultOpen = true) =>
  settingsSectionsShown({ vaultOpen, offered }).links.map((section) => section.title);

const EVERYTHING = Object.fromEntries(
  PLATFORM_CAPABILITIES.map((name) => [name, true]),
) as PlatformCapabilities;
const without = (name: PlatformCapability) => entryPointsOffered({ ...EVERYTHING, [name]: false });

/** The list on the left of Settings, as `app.tsx` draws the sections (UI v2 slice 13f). */
describe('settingsSectionsShown', () => {
  it('names every section, in the order the app draws them, with a vault open', () => {
    expect(
      settingsSectionsShown({ vaultOpen: true, offered: EVERY_ENTRY_POINT }).links.map(
        (section) => section.title,
      ),
    ).toEqual([
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
    expect(
      settingsSectionsShown({ vaultOpen: false, offered: EVERY_ENTRY_POINT }).links.map(
        (section) => section.title,
      ),
    ).toEqual(['Index', 'Images', 'Quick capture from anywhere', 'Claude', 'About']);
  });

  it('links each row to a heading of its own', () => {
    const ids = settingsSectionsShown({ vaultOpen: true, offered: EVERY_ENTRY_POINT }).links.map(
      (section) => section.id,
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('lists every section on the desktop: nothing it shows today goes (#657)', () => {
    expect(titles(entryPointsOffered(DESKTOP_CAPABILITIES))).toEqual(
      titles(entryPointsOffered(EVERYTHING)),
    );
    expect(titles(entryPointsOffered(DESKTOP_CAPABILITIES))).toHaveLength(13);
  });

  it.each([
    ['globalCapture', 'Quick capture from anywhere'],
    ['heldSecrets', 'Secrets'],
    ['googleCalendar', 'Google Calendar'],
    ['granola', 'Granola'],
    ['slack', 'Slack'],
    ['kindle', 'Kindle'],
    ['claudeCodeChat', 'Claude'],
    ['syncByGit', 'Sync'],
  ] as const)('leaves out its section without %s (#657)', (capability, title) => {
    const all = titles(entryPointsOffered(EVERYTHING));
    expect(all).toContain(title);
    expect(titles(without(capability))).toEqual(all.filter((each) => each !== title));
  });

  it('lists on the web only what a browser can do, with a vault open and without (#657)', () => {
    const web = entryPointsOffered(WEB_CAPABILITIES);
    expect(titles(web)).toEqual(['Profile', 'Index', 'Images', 'Quick add', 'About']);
    expect(titles(web, false)).toEqual(['Index', 'Images', 'About']);
  });

  it('hands back the same list for the same platform, so the dialog can memoise it', () => {
    const web = entryPointsOffered(WEB_CAPABILITIES);
    expect(settingsSectionsShown({ vaultOpen: true, offered: web })).toBe(
      settingsSectionsShown({ vaultOpen: true, offered: web }),
    );
  });
});
