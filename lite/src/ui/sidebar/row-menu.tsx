import { useEffect, useRef, type KeyboardEvent } from 'react';

export interface MenuItem {
  readonly label: string;
  readonly run: () => void;
  readonly danger?: boolean;
}

/** A row's context menu, at the point it was opened. Arrow keys move, Escape closes. */
export function RowMenu({
  items,
  at,
  label,
  onClose,
}: {
  items: readonly MenuItem[];
  at: { readonly x: number; readonly y: number };
  label: string;
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const closeOutside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) onClose();
    };
    window.addEventListener('pointerdown', closeOutside, true);
    return () => window.removeEventListener('pointerdown', closeOutside, true);
  }, [onClose]);

  const onKeyDown = (event: KeyboardEvent) => {
    const buttons = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      buttons[(at + step + buttons.length) % buttons.length]?.focus();
    }
  };

  return (
    <div
      ref={menu}
      className="row-menu"
      role="menu"
      aria-label={label}
      style={{ left: Math.min(at.x, window.innerWidth - 200), top: at.y }}
      onKeyDown={onKeyDown}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={item.danger === true ? 'row-menu-item is-danger' : 'row-menu-item'}
          onClick={() => {
            onClose();
            item.run();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
