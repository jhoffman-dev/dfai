import { useEffect } from 'react';

/**
 * Where a pasted Slack link is offered for saving: a note's editor, and a
 * field that asks for it with `data-paste-offers` (quick capture). The
 * editor is ProseMirror's, whose root always has that class. Anywhere else —
 * search, a property, a token field — a paste is only a paste.
 */
const OFFERED_IN = '.ProseMirror, [data-paste-offers]';

/**
 * Hands every paste of text into a note or quick capture to `offer`, which
 * says whether it is a Slack message link. The paste itself goes on as it
 * would: the link is kept where it was pasted, whatever comes of the offer.
 */
export function useSlackPasteListener(offer: (text: string) => boolean): void {
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      const element = target instanceof Element ? target : (target?.parentElement ?? null);
      if (element === null || element.closest(OFFERED_IN) === null) return;
      const text = event.clipboardData?.getData('text/plain') ?? '';
      if (text !== '') offer(text);
    };
    document.addEventListener('paste', onPaste, true);
    return () => document.removeEventListener('paste', onPaste, true);
  }, [offer]);
}
