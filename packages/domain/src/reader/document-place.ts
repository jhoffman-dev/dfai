import type { NavigationPlace } from '../panes/navigation-history.ts';
import type { VaultPath } from '../vault/vault-path.ts';
import { documentKindOf } from './document-kind.ts';

/** Where opening a file from Pages or search goes: a PDF or an EPUB to its reader, anything else to its note. */
export function placeOfFile(path: VaultPath): NavigationPlace {
  return documentKindOf(path) === null ? { kind: 'note', path } : { kind: 'document', path };
}
