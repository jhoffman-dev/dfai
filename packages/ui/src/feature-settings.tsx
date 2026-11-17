import { memo } from 'react';
import { SettingsSection } from './settings-section.tsx';
import { SETTINGS_SECTIONS } from './settings-section-links.ts';
import { Toggle } from './toggle.tsx';

/** One key feature's row in Settings → Features. */
export interface FeatureRow {
  readonly id: string;
  readonly label: string;
  /** One line saying what it is. */
  readonly summary: string;
  readonly on: boolean;
  /** The feature it needs that is switched off, which holds this one off too; null when none. */
  readonly needs: string | null;
}

/**
 * Settings → Features (#901): one row per key feature, with its switch. A
 * feature switched off leaves the view; nothing of it is deleted. The
 * switches wait until the vault's settings have been read, so a flip is never
 * made on a list that is not the vault's. Memoised: it draws once as Settings
 * opens, and again only when the switches change ("Open Settings" is held to a
 * work budget).
 */
export const FeatureSettings = memo(function FeatureSettings({
  rows,
  ready,
  problem,
  onSwitch,
}: {
  rows: readonly FeatureRow[];
  /** Whether the vault's settings have been read. */
  ready: boolean;
  /** Why the last switch was not saved. */
  problem: string | null;
  onSwitch: (change: { readonly id: string; readonly on: boolean }) => void;
}) {
  return (
    <SettingsSection section={SETTINGS_SECTIONS.features}>
      <p className="settings__lede">
        Switch off what you don’t use, and it leaves the sidebar, ⌘K and Settings for this vault.
        Nothing is deleted: switch it back on and it is all there.
      </p>
      {rows.map((row) => (
        <div className="settings__row" key={row.id}>
          <span className="settings__row-text">
            <span className="settings__row-label">{row.label}</span>
            <span className="settings__status">
              {row.needs === null ? row.summary : `${row.summary} Needs ${row.needs}.`}
            </span>
          </span>
          <Toggle
            label={row.label}
            checked={row.on}
            disabled={!ready || row.needs !== null}
            onChange={(on) => onSwitch({ id: row.id, on })}
          />
        </div>
      ))}
      {problem !== null && (
        <p className="settings__problem" role="alert">
          {problem}
        </p>
      )}
    </SettingsSection>
  );
});
