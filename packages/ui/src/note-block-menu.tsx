import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Menu } from '@base-ui/react/menu';
import type { Editor } from '@tiptap/core';
import type { BlockAction } from './editor/block-actions.ts';
import {
  BLOCK_MENU_REQUEST,
  availableBlockActions,
  blockMenuClosed,
  runBlockAction,
  type BlockMenuRequest,
} from './editor/block-handle.ts';
import type { HighlightBlocks } from './editor/raw-block.ts';
import { MenuItems, type MenuCommand } from './menu-items.tsx';

/** Each action's words and the keys that do it, as the menu shows them, in the menu's order. */
const ACTION_ROWS: readonly { action: BlockAction; label: string; shortcut: string }[] = [
  { action: 'addAbove', label: 'Add block above', shortcut: '⌥⇧↩' },
  { action: 'addBelow', label: 'Add block below', shortcut: '⌥↩' },
  { action: 'duplicate', label: 'Duplicate', shortcut: '⌘D' },
  { action: 'moveUp', label: 'Move up', shortcut: '⇧⌘↑' },
  { action: 'moveDown', label: 'Move down', shortcut: '⇧⌘↓' },
  { action: 'delete', label: 'Delete', shortcut: '⇧⌘⌫' },
];

/**
 * A block's menu (#569), hung from its handle: opened by a click on the
 * handle or by ⌘/ with the caret in the block. Open state, focus, arrow
 * keys, typeahead and Escape are Base UI's (ADR-0015); once it closes, the
 * caret goes back to the note.
 */
export function useBlockMenu({
  editor,
  highlights,
}: {
  editor: Editor | null;
  highlights: HighlightBlocks | null;
}): ReactNode {
  const [menu, setMenu] = useState<BlockMenuRequest | null>(null);

  useEffect(() => {
    if (editor === null) return;
    const element = editor.view.dom;
    const open = (event: Event) => setMenu((event as CustomEvent<BlockMenuRequest>).detail);
    element.addEventListener(BLOCK_MENU_REQUEST, open);
    return () => element.removeEventListener(BLOCK_MENU_REQUEST, open);
  }, [editor]);

  const close = () => {
    setMenu(null);
    if (editor === null || editor.isDestroyed) return;
    blockMenuClosed(editor.view);
    editor.commands.focus();
  };

  // Drawn only while open: a note is drawn on every key, and a closed menu would be drawn with it.
  if (editor === null || menu === null) return null;
  return (
    <BlockMenu anchor={menu.anchor} items={commandsFor(editor, menu, highlights)} onClose={close} />
  );
}

/** The menu itself, hung from the block's handle. */
function BlockMenu({
  anchor,
  items,
  onClose,
}: {
  anchor: Element;
  items: readonly MenuCommand[];
  onClose: () => void;
}) {
  const chosen = useRef<MenuCommand | null>(null);
  return (
    <Menu.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Menu.Portal>
        <Menu.Positioner
          className="menu-positioner"
          anchor={anchor}
          side="bottom"
          align="start"
          sideOffset={4}
        >
          <Menu.Popup className="menu" aria-label="Block" render={<ul />} finalFocus={false}>
            <MenuItems items={items} chosen={chosen} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** The menu's rows for the block asked for, those that would do nothing disabled. */
function commandsFor(
  editor: Editor,
  { target }: BlockMenuRequest,
  highlights: HighlightBlocks | null,
): MenuCommand[] {
  const available = availableBlockActions(editor.view, { target, highlights });
  return ACTION_ROWS.map(({ action, label, shortcut }) => ({
    label,
    shortcut,
    disabled: !available.has(action),
    destructive: action === 'delete',
    onSelect: () => runBlockAction(editor.view, { target, action, highlights }),
  }));
}
