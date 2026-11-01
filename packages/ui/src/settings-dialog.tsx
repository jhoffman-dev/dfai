import { memo, useMemo, useState, type ReactNode } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import type { ApiConnectionStatus } from '@dfai/application';
import { AppearanceSettings } from './appearance-settings.tsx';
import { Icon } from './icon.tsx';
import { SettingsSection } from './settings-section.tsx';
import { SETTINGS_SECTIONS, type SettingsSectionLink } from './settings-section-links.ts';
import type { ThemeStore } from './theme.ts';
import { Toggle } from './toggle.tsx';
import { useReturnFocus, type FocusFallback } from './return-focus.ts';

/** What Settings → Connections shows: the API as the host reports it, and the last action's outcome. */
export interface ConnectionSettingsState {
  /** Null until the host has said. */
  readonly status: ApiConnectionStatus | null;
  /** Why the last action failed. */
  readonly problem: string | null;
  /** What the last action did. */
  readonly notice: string | null;
  /** An action is under way; the controls wait for it. */
  readonly pending: boolean;
}

function statusLine(state: ConnectionSettingsState): string {
  const { status } = state;
  if (status === null) return state.problem === null ? 'Checking…' : 'Unknown';
  if (!status.enabled) return 'Off';
  if (status.running && status.port !== null) return `Running on port ${status.port}`;
  return 'On, but not running';
}

/** The sections the dialog draws itself, before the app's: Connections where it is offered. */
const OWN_SECTIONS: readonly SettingsSectionLink[] = [
  SETTINGS_SECTIONS.appearance,
  SETTINGS_SECTIONS.connections,
];
const APPEARANCE_ONLY: readonly SettingsSectionLink[] = [SETTINGS_SECTIONS.appearance];

/**
 * Settings, as a dialog: a list of its sections on the left and the sections
 * as hairline groups on the right. Appearance and Connections — the local API
 * that lets other tools on this machine read and write the vault through
 * DFAI — are its own; the app adds its sections after them.
 *
 * Focus trapping, Escape and the portal are Base UI's, as for the palettes
 * (ADR-0015).
 */
export function SettingsDialog({
  connection,
  mcp,
  themeStore,
  sections = [],
  connections,
  onEnable,
  onCopyToken,
  onRotateToken,
  onCopyMcpCommand,
  onClose,
  fallbackFocus,
  children,
}: {
  connection: ConnectionSettingsState;
  /** The Claude Code command that adds the MCP server; `placeholder` when its path must be filled in. */
  mcp: { readonly command: string; readonly placeholder: boolean };
  themeStore: ThemeStore;
  /** The app's sections, in the order `children` draws them, for the list on the left. */
  sections?: readonly SettingsSectionLink[];
  /** Whether Connections is drawn: false where there is no local API to connect to. */
  connections: boolean;
  onEnable: (enabled: boolean) => void;
  onCopyToken: () => void;
  onRotateToken: () => void;
  onCopyMcpCommand: () => void;
  onClose: () => void;
  fallbackFocus?: FocusFallback;
  /** Sections after Connections — the index, for one. */
  children?: ReactNode;
}) {
  const finalFocus = useReturnFocus(fallbackFocus);
  const { status, problem, notice, pending } = connection;
  // The same array while the app's sections are, so the list is not redrawn
  // each time the connection's state comes in.
  const listed = useMemo(
    () => [...(connections ? OWN_SECTIONS : APPEARANCE_ONLY), ...sections],
    [connections, sections],
  );

  return settingsFrame({
    onClose,
    finalFocus,
    sections: listed,
    body: (
      <>
        <AppearanceSettings store={themeStore} />
        {connections && (
          <SettingsSection section={SETTINGS_SECTIONS.connections}>
            <p className="settings__lede">
              Let other tools on this Mac, such as Claude Code, read and write this vault through
              DFAI while it is open.
            </p>
            <div className="settings__row">
              <span className="settings__row-text">
                <span className="settings__row-label">Local API</span>
                <span className="settings__status" data-testid="api-status">
                  {statusLine(connection)}
                </span>
              </span>
              <Toggle
                label="Local API"
                checked={status?.enabled ?? false}
                disabled={pending || status === null}
                onChange={onEnable}
              />
            </div>
            {problem !== null && (
              <p className="settings__problem" role="alert">
                {problem}
              </p>
            )}
            <p className="settings__notice" aria-live="polite">
              {notice}
            </p>
            <TokenActions pending={pending} onCopy={onCopyToken} onRotate={onRotateToken} />
            <McpCommand mcp={mcp} pending={pending} onCopy={onCopyMcpCommand} />
            {status !== null && (
              <p className="settings__file">
                Connection file <code>{status.file}</code>
              </p>
            )}
          </SettingsSection>
        )}
        {children}
      </>
    ),
  });
}

/** Copy and rotate. Rotating locks out whatever holds the old token, so it asks first. */
function TokenActions({
  pending,
  onCopy,
  onRotate,
}: {
  pending: boolean;
  onCopy: () => void;
  onRotate: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return (
      <div className="settings__confirm" role="group" aria-label="Rotate the token?">
        <p className="settings__lede">
          Anything using the current token is refused until it reads the new one.
        </p>
        <div className="settings__actions">
          <button
            className="btn btn--primary"
            type="button"
            onClick={() => {
              setConfirming(false);
              onRotate();
            }}
          >
            Rotate
          </button>
          <button className="btn btn--ghost" type="button" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="settings__actions">
      <button className="btn btn--secondary" type="button" disabled={pending} onClick={onCopy}>
        Copy token
      </button>
      <button
        className="btn btn--secondary"
        type="button"
        disabled={pending}
        onClick={() => setConfirming(true)}
      >
        Rotate token…
      </button>
    </div>
  );
}

function McpCommand({
  mcp,
  pending,
  onCopy,
}: {
  mcp: { readonly command: string; readonly placeholder: boolean };
  pending: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="settings__mcp">
      <h3 className="settings__subtitle">MCP server for Claude Code</h3>
      <code className="settings__code">{mcp.command}</code>
      {mcp.placeholder && (
        <p className="settings__lede">
          Replace the path with where DFAI is checked out, after building it.
        </p>
      )}
      <div className="settings__actions">
        <button className="btn btn--secondary" type="button" disabled={pending} onClick={onCopy}>
          Copy MCP command
        </button>
      </div>
    </div>
  );
}

/** Brings a section into view and hands it the focus, by its heading. */
function reveal(section: SettingsSectionLink): void {
  const heading = document.getElementById(section.id);
  if (heading === null) return;
  heading.scrollIntoView({ block: 'start' });
  // Focus would scroll too, and might not agree about where.
  heading.focus({ preventScroll: true });
}

/**
 * The sections, as 28px rows on the left, each a way to its section. Drawn
 * once per list: the dialog redraws as the host answers, and the rows do
 * not change with it.
 */
const SectionList = memo(function SectionList({
  sections,
}: {
  sections: readonly SettingsSectionLink[];
}) {
  return (
    <nav className="settings__nav" aria-label="Settings sections">
      <ul className="settings__nav-list">
        {sections.map((section) => (
          <li key={section.id}>
            <button className="settings__nav-row" type="button" onClick={() => reveal(section)}>
              <Icon name={section.icon} size={15} className="settings__nav-icon" />
              {section.title}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
});

/**
 * Settings' window — its title, its Close and Escape, the focus it returns,
 * and the list of sections when there are any — around `body`. A plain
 * function rather than a component, so that drawing Settings through it adds
 * nothing to each render.
 */
function settingsFrame({
  onClose,
  finalFocus,
  sections = [],
  body,
}: {
  onClose: () => void;
  finalFocus: ReturnType<typeof useReturnFocus>;
  sections?: readonly SettingsSectionLink[];
  body: ReactNode;
}) {
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Viewport className="palette__backdrop">
          <Dialog.Popup className="palette settings" finalFocus={finalFocus} aria-label="Settings">
            <header className="settings__header">
              <h1 className="settings__title">Settings</h1>
              <Dialog.Close className="icon-button" aria-label="Close">
                <Icon name="close" size={16} />
              </Dialog.Close>
            </header>
            <div className="settings__columns">
              {sections.length > 0 && <SectionList sections={sections} />}
              <div className="settings__body">{body}</div>
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Settings' window with something else in it — what the app shows when the
 * sections themselves cannot be drawn. It closes as Settings does.
 */
export function SettingsUnavailable({
  onClose,
  fallbackFocus,
  children,
}: {
  onClose: () => void;
  fallbackFocus?: FocusFallback;
  children: ReactNode;
}) {
  const finalFocus = useReturnFocus(fallbackFocus);
  return settingsFrame({ onClose, finalFocus, body: children });
}
