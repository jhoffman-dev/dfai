import { memo } from 'react';
import { SettingsSection } from './settings-section.tsx';
import { SETTINGS_SECTIONS } from './settings-section-links.ts';

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
 * made on a list that is not the vault's, and one whose feature needs another
 * that is off is held too, saying why. A held switch is `aria-disabled`
 * rather than disabled: Tab still reaches it and a screen reader reads the
 * reason, and pressing it does nothing. Memoised: it draws once as Settings
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
      {rows.map((row) => {
        const why = `feature-${row.id}-needs`;
        // Held, not disabled, so Tab still reaches it and a screen reader hears why.
        const held = !ready || row.needs !== null;
        return (
          <div className="settings__row" key={row.id}>
            <span className="settings__row-text">
              <span className="settings__row-label">{row.label}</span>
              <span className="settings__status">
                {row.summary}
                {row.needs !== null && (
                  <>
                    {' '}
                    <span id={why}>Needs {row.needs}.</span>
                  </>
                )}
              </span>
            </span>
            {/* `Toggle`'s markup and classes (`toggle.tsx`), drawn in place: a component per
                row would be a counted render per feature ("Open Settings" is held to a work
                budget). A change to the markup or classes there is made here too. */}
            <button
              type="button"
              role="switch"
              className="toggle"
              aria-checked={row.on}
              aria-label={row.label}
              aria-disabled={held}
              {...(row.needs !== null && { 'aria-describedby': why })}
              onClick={() => {
                if (!held) onSwitch({ id: row.id, on: !row.on });
              }}
            >
              <span className="toggle__knob" />
            </button>
          </div>
        );
      })}
      {problem !== null && (
        <p className="settings__problem" role="alert">
          {problem}
        </p>
      )}
    </SettingsSection>
  );
});
