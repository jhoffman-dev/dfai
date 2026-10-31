import type { IconName } from './icon.tsx';

/** How a part of Settings is named: its heading's id, its title, and its icon in the list of sections. */
export interface SettingsSectionLink {
  readonly id: string;
  readonly title: string;
  readonly icon: IconName;
}

/**
 * Every part of Settings, by the name the app draws it under. A section draws
 * its own heading from its link, and the dialog's list on the left is built
 * from the same links, so the two cannot say different things.
 */
export const SETTINGS_SECTIONS = {
  appearance: { id: 'settings-appearance', title: 'Appearance', icon: 'sun' },
  connections: { id: 'settings-connections', title: 'Connections', icon: 'link' },
  profile: { id: 'settings-profile', title: 'Profile', icon: 'person' },
  index: { id: 'settings-index', title: 'Index', icon: 'search' },
  images: { id: 'settings-images', title: 'Images', icon: 'image' },
  globalCapture: {
    id: 'settings-global-capture',
    title: 'Quick capture from anywhere',
    icon: 'inbox',
  },
  quickAdd: { id: 'settings-quick-add', title: 'Quick add', icon: 'plus' },
  secrets: { id: 'settings-secrets', title: 'Secrets', icon: 'key' },
  googleCalendar: { id: 'settings-google-calendar', title: 'Google Calendar', icon: 'calendar' },
  granola: { id: 'settings-granola', title: 'Granola', icon: 'event' },
  slack: { id: 'settings-slack', title: 'Slack', icon: 'hash' },
  kindle: { id: 'settings-kindle', title: 'Kindle', icon: 'doc' },
  claude: { id: 'settings-claude', title: 'Claude', icon: 'spark' },
  sync: { id: 'settings-sync', title: 'Sync', icon: 'cloud' },
  about: { id: 'settings-about', title: 'About', icon: 'id' },
} as const satisfies Record<string, SettingsSectionLink>;
