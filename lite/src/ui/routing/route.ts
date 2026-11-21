import type { VaultPath } from '../../domain/vault/index.ts';

/** What the main pane shows, as the URL's hash says it. */
export type Route =
  | { readonly kind: 'home' }
  | { readonly kind: 'note'; readonly path: VaultPath }
  | { readonly kind: 'tags'; readonly tag: string | null }
  | { readonly kind: 'graph' }
  /** Make a quick note and open it: what a Shortcut or Dock icon opens. */
  | { readonly kind: 'new' };

const NOTE = '#/note/';
const TAGS = '#/tags';

function decoded(part: string): string | null {
  try {
    return decodeURIComponent(part);
  } catch {
    // A hand-typed hash with a stray `%`: shown as the home page, not an error.
    return null;
  }
}

export function parseRoute(hash: string): Route {
  if (hash.startsWith(NOTE)) {
    const path = decoded(hash.slice(NOTE.length));
    return path === null || path === '' ? { kind: 'home' } : { kind: 'note', path };
  }
  if (hash === TAGS || hash === `${TAGS}/`) return { kind: 'tags', tag: null };
  if (hash.startsWith(`${TAGS}/`)) {
    const tag = decoded(hash.slice(TAGS.length + 1));
    return { kind: 'tags', tag: tag === '' ? null : tag };
  }
  if (hash === '#/graph') return { kind: 'graph' };
  if (hash === '#/new') return { kind: 'new' };
  return { kind: 'home' };
}

export function formatRoute(route: Route): string {
  switch (route.kind) {
    case 'home':
      return '#/';
    case 'note':
      return `${NOTE}${encodeURIComponent(route.path)}`;
    case 'tags':
      return route.tag === null ? TAGS : `${TAGS}/${encodeURIComponent(route.tag)}`;
    case 'graph':
      return '#/graph';
    case 'new':
      return '#/new';
  }
}

/** Whether the page was opened to make a new note: `#/new`, or `?new` on the URL. */
export function asksForNewNote(location: { readonly hash: string; readonly search: string }) {
  return location.hash === '#/new' || new URLSearchParams(location.search).has('new');
}
