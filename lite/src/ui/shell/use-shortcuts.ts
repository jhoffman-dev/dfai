import { useEffect } from 'react';
import type { Route } from '../routing/route.ts';
import { useApp } from '../services.ts';

/**
 * The app's keys, caught before the editor sees them:
 * ⌘/Ctrl-N and Alt-N (a browser tab keeps ⌘N for itself) make a note,
 * ⌘/Ctrl-K searches, ⌘/Ctrl-E reads or edits, F2 renames the open note.
 */
export function useShortcuts(route: Route): void {
  const { actions, ui } = useApp();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      // `code`, not `key`: Alt-N types "˜" on a Mac keyboard.
      const n = event.code === 'KeyN' && !event.shiftKey;
      if ((mod && n) || (event.altKey && !mod && n)) {
        actions.newNote().catch(actions.report);
      } else if (mod && event.key.toLowerCase() === 'k') {
        ui.setState({ paletteOpen: true });
      } else if (mod && event.key.toLowerCase() === 'e' && route.kind === 'note') {
        actions.togglePreview();
      } else if (event.key === 'F2' && route.kind === 'note') {
        ui.setState({ pendingFocus: { path: route.path, target: 'title' } });
      } else {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [actions, ui, route]);
}
