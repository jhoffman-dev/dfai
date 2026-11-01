import { useCallback, useState } from 'react';

/** Where focus goes when an overlay closes and what opened it has gone. */
export type FocusFallback = () => HTMLElement | null;

/**
 * A dialog's `finalFocus` that hands focus back to what opened it — or, if that
 * element has left the document while the dialog was up (its note deleted, the
 * menu it sat in closed), or nothing held the focus when it opened (WebKit does
 * not focus a button that is clicked), to `fallback` rather than to `<body>`.
 *
 * `unheld` names an opener that is not where the person put the focus either:
 * WebKit, not focusing the clicked button, focuses the nearest focusable
 * ancestor instead, and a dialog whose button sits in such a frame says so.
 *
 * The opener is read on the first render, which runs before Base UI moves focus
 * into the dialog.
 */
export function useReturnFocus(
  fallback: FocusFallback | undefined,
  { unheld = never }: { unheld?: (opener: HTMLElement) => boolean } = {},
) {
  const [opener] = useState(() => document.activeElement);
  return useCallback(() => {
    if (
      opener instanceof HTMLElement &&
      opener !== document.body &&
      opener.isConnected &&
      !unheld(opener)
    ) {
      return true;
    }
    // `true` is Base UI's own restore: the best it can do with no fallback.
    return fallback?.() ?? true;
  }, [opener, fallback, unheld]);
}

const never = (): boolean => false;
