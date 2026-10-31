import { Suspense, type ReactNode } from 'react';
import type { ActivityLog, ApiSettingsPort } from '@dfai/application';
import type { SettingsSectionLink, ThemeStore } from '@dfai/ui';
import { settingsDialog } from '../pages-on-first-use.ts';
import type { ClipboardWriter } from './clipboard.ts';
import { mcpAddCommand } from './mcp-command.ts';
import { useConnectionSettings } from './use-connection-settings.ts';

// Loaded on first use, with the sections the app hands it (`pages-on-first-use.ts`).
const SettingsDialog = settingsDialog.Component;

/** What Settings needs from the app around it. */
export interface SettingsPorts {
  readonly settings: ApiSettingsPort;
  readonly clipboard: ClipboardWriter;
  /** Where the MCP server was built, when this build knows; null otherwise. */
  readonly mcpEntry: string | null;
}

/** Settings, wired to the host. */
export function SettingsPanel({
  ports,
  themeStore,
  activity,
  sections,
  onClose,
  fallbackFocus,
  children,
}: {
  ports: SettingsPorts;
  /** Where the theme choice is kept, for Settings → Appearance. */
  themeStore: ThemeStore;
  /** Where a change to the connection that fails is recorded. */
  activity: Pick<ActivityLog, 'inOpenVault'>;
  /** The sections `children` draws, in order, for the dialog's list of them. */
  sections?: readonly SettingsSectionLink[];
  onClose: () => void;
  fallbackFocus?: () => HTMLElement | null;
  /** Sections after Connections, which the app supplies. */
  children?: ReactNode;
}) {
  const connection = useConnectionSettings({ ...ports, activity });
  const mcp = mcpAddCommand(ports.mcpEntry);

  return (
    // Nothing until the dialog's chunk arrives: it opens over the page, so nothing moves.
    <Suspense fallback={null}>
      <SettingsDialog
        connection={connection}
        mcp={mcp}
        themeStore={themeStore}
        onEnable={connection.setEnabled}
        onCopyToken={connection.copyToken}
        onRotateToken={connection.rotateToken}
        onCopyMcpCommand={() =>
          connection.copyText({ text: mcp.command, notice: 'MCP command copied' })
        }
        onClose={onClose}
        {...(sections ? { sections } : {})}
        {...(fallbackFocus ? { fallbackFocus } : {})}
      >
        {children}
      </SettingsDialog>
    </Suspense>
  );
}
