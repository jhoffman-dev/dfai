import { useEffect, useRef } from 'react';
import { asksForNewNote, type Route } from '../routing/route.ts';
import { navigate } from '../routing/use-route.ts';
import { useApp } from '../services.ts';

/**
 * Where the window goes by itself: `#/new` or `?new` make a note at once
 * (what a Shortcut or Dock icon opens), an empty hash reopens the note last
 * open on this device, and each note opened is remembered for next time.
 */
export function useStartRoute(route: Route): void {
  const { actions, services } = useApp();
  const started = useRef(false);
  const making = useRef(false);

  useEffect(() => {
    const first = !started.current;
    started.current = true;
    if (route.kind === 'new' || (first && asksForNewNote(window.location))) {
      if (making.current) return;
      making.current = true;
      actions
        .newNote({ replace: true })
        .catch(actions.report)
        .finally(() => {
          making.current = false;
        });
      return;
    }
    if (first && route.kind === 'home') {
      const last = services.settings.load().ui.lastOpenPath;
      if (last !== null && services.session.file(last) !== null) {
        navigate({ kind: 'note', path: last }, { replace: true });
      }
    }
  }, [route, actions, services]);

  const openPath = route.kind === 'note' ? route.path : null;
  useEffect(() => {
    if (openPath !== null) actions.updatePrefs({ lastOpenPath: openPath });
  }, [openPath, actions]);
}
