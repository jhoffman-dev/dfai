import { Menu } from '@base-ui/react/menu';
import { typeIcon } from '@dfai/domain';
import { Icon, sidebarGlyph } from './icon.tsx';

export interface TemplateChoice {
  readonly path: string;
  readonly name: string;
}

/**
 * The top of the sidebar: which vault is open, how to add to it, and how to put
 * the sidebar away.
 */
export function VaultHeader({
  vaultName,
  vaultInitial,
  templates,
  onChooseVault,
  onOpenFromGitHub,
  onNewNote,
  onNewFromTemplate,
  onDailyNote,
  onNewArtifact,
  onHideSidebar,
  menuOpen,
  onMenuOpenChange,
}: {
  vaultName: string;
  /** The letter on the vault's tile. */
  vaultInitial: string;
  templates: readonly TemplateChoice[];
  /** Given when another folder can be opened as the vault: the name then opens one. */
  onChooseVault?: () => void;
  /** Given with `onChooseVault`, when a vault can be opened from GitHub: the name then opens a menu of both ways. */
  onOpenFromGitHub?: () => void;
  onNewNote: () => void;
  onNewFromTemplate: (path: string) => void;
  onDailyNote: () => void;
  /** Given when artifacts can be saved from here: opens New artifact. */
  onNewArtifact?: () => void;
  /** Given when the sidebar can be hidden from here. */
  onHideSidebar?: () => void;
  /**
   * The new-note menu's open state, when the app owns it — so opening another
   * overlay can close the menu. Left out, the menu keeps its own.
   */
  menuOpen?: boolean;
  onMenuOpenChange?: (open: boolean) => void;
}) {
  return (
    <div className="vault-header">
      <span className="vault-header__tile" aria-hidden="true">
        {vaultInitial}
      </span>
      {onChooseVault === undefined ? (
        <span className="vault-header__name">
          <span className="vault-header__label" title={vaultName}>
            {vaultName}
          </span>
        </span>
      ) : onOpenFromGitHub === undefined ? (
        <button
          className="vault-header__name"
          type="button"
          onClick={onChooseVault}
          title="Choose a different folder"
        >
          <VaultName name={vaultName} />
        </button>
      ) : (
        <VaultSwitcher
          vaultName={vaultName}
          onChooseVault={onChooseVault}
          onOpenFromGitHub={onOpenFromGitHub}
        />
      )}

      {/* Open state, outside-press, roving focus, typeahead, Escape and the
          portal are Base UI's — see ADR-0015. The menu hangs off the trigger,
          its right edge on the trigger's. */}
      <Menu.Root open={menuOpen} onOpenChange={(open) => onMenuOpenChange?.(open)}>
        <Menu.Trigger className="icon-button" title="New note (⌘N)" aria-label="New note">
          <Icon name="plus" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner className="menu-positioner" side="bottom" align="end" sideOffset={6}>
            <Menu.Popup
              className="menu"
              // Base UI labels the menu from its trigger, which would name it
              // "New note"; the name the app has always used wins.
              aria-labelledby={undefined}
              aria-label="New note from"
              render={<ul />}
            >
              <li>
                <Menu.Item nativeButton render={<button type="button" />} onClick={onNewNote}>
                  <Icon name="doc" size={16} />
                  <span className="menu__label">Blank note</span>
                  <kbd className="key menu__shortcut" aria-hidden="true">
                    ⌘N
                  </kbd>
                </Menu.Item>
              </li>
              <li>
                <Menu.Item nativeButton render={<button type="button" />} onClick={onDailyNote}>
                  <Icon name="sun" size={16} />
                  <span className="menu__label">Today&apos;s note</span>
                  <kbd className="key menu__shortcut" aria-hidden="true">
                    ⇧⌘D
                  </kbd>
                </Menu.Item>
              </li>
              {onNewArtifact !== undefined && (
                <li>
                  <Menu.Item nativeButton render={<button type="button" />} onClick={onNewArtifact}>
                    <Icon name="artifact" size={16} />
                    <span className="menu__label">Claude artifact…</span>
                  </Menu.Item>
                </li>
              )}
              {templates.length > 0 && <li className="menu__divider" role="separator" />}
              {templates.map((template) => (
                <li key={template.path}>
                  <Menu.Item
                    nativeButton
                    render={<button type="button" />}
                    onClick={() => onNewFromTemplate(template.path)}
                  >
                    <Icon name={sidebarGlyph(typeIcon(template.name))} size={16} />
                    <span className="menu__label">{template.name}</span>
                  </Menu.Item>
                </li>
              ))}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      {onHideSidebar !== undefined && (
        <button
          className="icon-button"
          type="button"
          onClick={onHideSidebar}
          aria-label="Hide sidebar"
          title="Hide sidebar (⌘\)"
        >
          <Icon name="panel" />
        </button>
      )}
    </div>
  );
}

function VaultName({ name }: { name: string }) {
  return (
    <>
      <span className="vault-header__label" title={name}>
        {name}
      </span>
      <Icon name="chevron" size={12} className="vault-header__chevron" />
    </>
  );
}

/** The vault's name as a menu: open another folder, or a vault kept on GitHub. */
function VaultSwitcher({
  vaultName,
  onChooseVault,
  onOpenFromGitHub,
}: {
  vaultName: string;
  onChooseVault: () => void;
  onOpenFromGitHub: () => void;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger className="vault-header__name" title="Open another vault">
        <VaultName name={vaultName} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="menu-positioner" side="bottom" align="start" sideOffset={6}>
          <Menu.Popup className="menu" aria-label="Open another vault" render={<ul />}>
            <li>
              <Menu.Item nativeButton render={<button type="button" />} onClick={onChooseVault}>
                <Icon name="folder" size={16} />
                <span className="menu__label">Open another folder…</span>
              </Menu.Item>
            </li>
            <li>
              <Menu.Item nativeButton render={<button type="button" />} onClick={onOpenFromGitHub}>
                <Icon name="cloud" size={16} />
                <span className="menu__label">Open a vault from GitHub…</span>
              </Menu.Item>
            </li>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
