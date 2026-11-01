import { formatTag, vaultPathName, type NavigationPlace, type VaultPath } from '@dfai/domain';

/**
 * What a place Back or Forward leads to is called, for the button's tooltip:
 * a note by the title its page shows, a type by its label, a tag as it is
 * shown, and the graph, query and tags pages by the names their own bars give them.
 */
export function placeName(
  place: NavigationPlace,
  {
    titleOf,
    typeLabelOf,
    tagNameOf = (key) => key,
  }: {
    titleOf: (path: VaultPath) => string;
    typeLabelOf: (name: string) => string;
    /** A tag's name as first written, from its key. */
    tagNameOf?: (key: string) => string;
  },
): string {
  switch (place.kind) {
    case 'note':
      return titleOf(place.path);
    case 'type':
      return typeLabelOf(place.name);
    case 'graph':
      return place.scope.kind === 'vault' ? 'Graph' : `Graph around ${titleOf(place.scope.path)}`;
    case 'query':
      return 'Query';
    case 'tags':
      return place.tag === null ? 'Tags' : formatTag(tagNameOf(place.tag));
    case 'archive':
      return 'Archive';
    case 'inbox':
      return 'Inbox';
    case 'review':
      return 'Weekly review';
    case 'today':
      return 'Today';
    case 'automations':
      return 'Automations';
    case 'activity':
      return 'Activity';
    case 'templates':
      return 'Templates';
    case 'terms':
      return 'Terms';
    case 'skills':
      return 'Skills';
    case 'library':
      return 'Library';
    case 'highlights':
      return 'All highlights';
    case 'ask':
      return 'Ask';
    case 'document':
      return vaultPathName(place.path);
  }
}
