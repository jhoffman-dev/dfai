import { useCallback, useRef, type KeyboardEvent } from 'react';

/**
 * Suggest's keys on the Inbox page (#900, #903): Escape anywhere in the page
 * puts the suggestions away, unless something in it used the key first; and
 * putting them away hands the focus back to Suggest when the focus was in
 * them, or nowhere, so the keyboard never loses its place.
 */
export function useAssistKeys(
  assist: { readonly view: unknown; readonly onDismiss: () => void } | null,
) {
  const suggest = useRef<HTMLButtonElement>(null);
  const dismiss = useCallback(() => {
    if (assist === null) return;
    const focused = document.activeElement;
    const focusWasHere =
      focused === null || focused === document.body || focused.closest('.inbox-assist') !== null;
    assist.onDismiss();
    if (focusWasHere) suggest.current?.focus();
  }, [assist]);
  const onPageKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        assist === null ||
        assist.view === null
      ) {
        return;
      }
      event.preventDefault();
      dismiss();
    },
    [assist, dismiss],
  );
  return { suggest, dismiss, onPageKeyDown };
}
