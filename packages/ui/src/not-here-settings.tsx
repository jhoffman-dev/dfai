import { memo } from 'react';
import type { PlatformLimit } from '@dfai/application';
import { SettingsSection } from './settings-section.tsx';
import { SETTINGS_SECTIONS } from './settings-section-links.ts';

/**
 * Settings → Not available here: what DFAI cannot do where it runs, and why
 * (#670). The list is the platform's, decided in the application from its
 * capabilities; the section only draws it, and is left out where it is empty.
 */
export const NotHereSettings = memo(function NotHereSettings({
  limits,
}: {
  limits: readonly PlatformLimit[];
}) {
  return (
    <SettingsSection section={SETTINGS_SECTIONS.notHere}>
      <p className="settings__lede">
        These need the desktop app. Everything else works here, on the same vault.
      </p>
      <ul className="settings__limits">
        {limits.map((limit) => (
          <li key={limit.what} className="settings__row-text">
            <span className="settings__row-label">{limit.what}</span>
            <span className="settings__status">{limit.why}</span>
          </li>
        ))}
      </ul>
    </SettingsSection>
  );
});
