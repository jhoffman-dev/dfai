import { describe, expect, it } from 'vitest';
import { entryPointsOffered, EVERY_ENTRY_POINT } from '@dfai/application';
import {
  DESKTOP_CAPABILITIES,
  PLATFORM_CAPABILITIES,
  WEB_CAPABILITIES,
  type FeatureId,
  type PlatformCapabilities,
  type PlatformCapability,
} from '@dfai/domain';
import { offeredFor } from '../features/offered-for.ts';
import { APP_SETTINGS_ORDER, settingsSectionsShown } from './settings-sections.ts';

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
      'Features',
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
    expect(titles(entryPointsOffered(DESKTOP_CAPABILITIES))).toHaveLength(
      APP_SETTINGS_ORDER.filter((entry) => entry.whenLimited !== true).length,
    );
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
    expect(titles(web)).toEqual(['Profile', 'Features', 'Index', 'Images', 'Quick add', 'About']);
    expect(titles(web, false)).toEqual(['Index', 'Images', 'About']);
  });

  it('hands back the same list for the same platform, so the dialog can memoise it', () => {
    const web = entryPointsOffered(WEB_CAPABILITIES);
    expect(settingsSectionsShown({ vaultOpen: true, offered: web })).toBe(
      settingsSectionsShown({ vaultOpen: true, offered: web }),
    );
  });
});

describe('settingsSectionsShown: Features (#901)', () => {
  const desktop = entryPointsOffered(DESKTOP_CAPABILITIES);

  it("lists Features after Profile, with a vault open only: the switches are the vault's", () => {
    const open = titles(desktop);
    expect(open.slice(open.indexOf('Profile'), open.indexOf('Profile') + 2)).toEqual([
      'Profile',
      'Features',
    ]);
    expect(titles(desktop, false)).not.toContain('Features');
  });

  it('keeps Features, and every other section but Kindle, which needs it, with Reading switched off', () => {
    const readingOff = offeredFor(desktop, ['reading']);
    expect(titles(readingOff)).toEqual(titles(desktop).filter((title) => title !== 'Kindle'));
  });

  it('takes out Kindle and Slack with their switches, and keeps Claude with Ask and Graph off', () => {
    expect(titles(offeredFor(desktop, ['kindle']))).toEqual(
      titles(desktop).filter((title) => title !== 'Kindle'),
    );
    expect(titles(offeredFor(desktop, ['slack']))).toEqual(
      titles(desktop).filter((title) => title !== 'Slack'),
    );
    expect(titles(desktop)).toContain('Claude');
    expect(titles(offeredFor(desktop, ['ask', 'graph']))).toEqual(titles(desktop));
  });

  it('makes the lists once for each off list, and again only when that list changes', () => {
    const shown = (off: readonly FeatureId[]) =>
      settingsSectionsShown({ vaultOpen: true, offered: offeredFor(desktop, off) });
    expect(shown([])).toBe(settingsSectionsShown({ vaultOpen: true, offered: desktop }));
    expect(shown(['reading'])).toBe(shown([...['reading' as const]]));
    expect(shown(['reading'])).not.toBe(shown([]));
  });
});

describe('settingsSectionsShown: Not available here (#670)', () => {
  const web = entryPointsOffered(WEB_CAPABILITIES);

  it('lists it before About where the platform lacks something, with a vault open or not', () => {
    for (const vaultOpen of [true, false]) {
      const shown = settingsSectionsShown({ vaultOpen, offered: web, limited: true });
      expect(shown.links.map((section) => section.title).slice(-2)).toEqual([
        'Not available here',
        'About',
      ]);
      expect(shown.keys.slice(-2)).toEqual(['notHere', 'about']);
    }
  });

  it('leaves it out where nothing is lacking', () => {
    const shown = settingsSectionsShown({ vaultOpen: true, offered: EVERY_ENTRY_POINT });
    expect(shown.keys).not.toContain('notHere');
    expect(
      settingsSectionsShown({ vaultOpen: true, offered: EVERY_ENTRY_POINT, limited: false }),
    ).toBe(shown);
  });

  it('hands back the same lists each time for the same platform, limited or not', () => {
    const limited = settingsSectionsShown({ vaultOpen: true, offered: web, limited: true });
    expect(settingsSectionsShown({ vaultOpen: true, offered: web, limited: true })).toBe(limited);
    expect(settingsSectionsShown({ vaultOpen: true, offered: web })).not.toBe(limited);
  });
});
