import type { NavigationPlace } from '../panes/navigation-history.ts';
import type { VaultPath } from '../vault/vault-path.ts';

/**
 * The one page the sidebar marks as where you are: a note (which covers views
 * and dashboards, since they are notes too), a type's table, or nothing.
 */
export type ActiveSidebarPage =
  | { readonly kind: 'note'; readonly path: VaultPath }
  | { readonly kind: 'type'; readonly name: string }
  | { readonly kind: 'graph' }
  | { readonly kind: 'tags' }
  | { readonly kind: 'archive' }
  | { readonly kind: 'inbox' }
  | { readonly kind: 'review' }
  | { readonly kind: 'today' }
  | { readonly kind: 'automations' }
  | { readonly kind: 'activity' }
  | { readonly kind: 'templates' }
  | { readonly kind: 'terms' }
  | { readonly kind: 'skills' }
  | { readonly kind: 'library' }
  | { readonly kind: 'highlights' }
  | { readonly kind: 'ask' }
  | null;

/**
 * Which page the sidebar marks, given the place the focused pane's active tab
 * shows (docs/design/tab-model.md). Exactly one: with a split the other pane
 * is on screen too, but it is not where the next open lands, and marking it
 * as well would leave the sidebar unable to say which one you are in. With
 * pages as tabs there is nothing "over" the panes, so the one place says it
 * all. The query page has no sidebar row to mark.
 */
export function activeSidebarPageOf(
  place: NavigationPlace | null,
  viewOwner: (path: VaultPath) => string | null,
): ActiveSidebarPage {
  if (place === null) return null;
  switch (place.kind) {
    case 'note': {
      const owner = viewOwner(place.path);
      return owner === null ? { kind: 'note', path: place.path } : { kind: 'type', name: owner };
    }
    case 'document':
      // The PDF's own row in Pages is marked, as a note's is.
      return { kind: 'note', path: place.path };
    case 'type':
      return { kind: 'type', name: place.name };
    case 'query':
      return null;
    case 'graph':
    case 'tags':
    case 'archive':
    case 'inbox':
    case 'review':
    case 'today':
    case 'automations':
    case 'activity':
    case 'templates':
    case 'terms':
    case 'skills':
    case 'library':
    case 'highlights':
    case 'ask':
      return { kind: place.kind };
  }
}
