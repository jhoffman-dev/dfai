import type { VaultPath } from '../../domain/vault/index.ts';
import type { NoteActions } from '../state/note-actions.ts';
import type { MenuItem } from './row-menu.tsx';

/** What a context menu was opened on, and where. */
export type MenuTarget =
  | {
      readonly kind: 'note';
      readonly path: VaultPath;
      readonly x: number;
      readonly y: number;
      /** Where it sits in the favourites, when opened there; null in the tree. */
      readonly favoriteAt: number | null;
    }
  | { readonly kind: 'folder'; readonly path: VaultPath; readonly x: number; readonly y: number };

export interface MenuContext {
  readonly actions: NoteActions;
  readonly favorites: readonly VaultPath[];
  readonly activePath: VaultPath | null;
  readonly title: (path: VaultPath) => string;
  readonly askMove: (path: VaultPath) => void;
  readonly confirm: (message: string) => boolean;
}

function favoriteMoves(path: VaultPath, at: number, context: MenuContext): MenuItem[] {
  const { actions, favorites } = context;
  const moves: MenuItem[] = [];
  const later = (promise: Promise<void>) => void promise.catch(actions.report);
  if (at > 0)
    moves.push({ label: 'Move up', run: () => later(actions.moveFavorite(path, at - 1)) });
  if (at < favorites.length - 1) {
    moves.push({ label: 'Move down', run: () => later(actions.moveFavorite(path, at + 1)) });
  }
  return moves;
}

export function menuItemsFor(target: MenuTarget, context: MenuContext): MenuItem[] {
  const { actions } = context;
  const later = (promise: Promise<unknown>) => void promise.catch(actions.report);
  if (target.kind === 'folder') {
    return [{ label: 'New note here', run: () => later(actions.newNote({ folder: target.path })) }];
  }
  const { path } = target;
  const isFavorite = context.favorites.includes(path);
  return [
    { label: 'Rename', run: () => actions.startRename(path) },
    { label: 'Move to folder…', run: () => context.askMove(path) },
    {
      label: isFavorite ? 'Remove from favourites' : 'Add to favourites',
      run: () => later(actions.toggleFavorite(path)),
    },
    ...(target.favoriteAt === null ? [] : favoriteMoves(path, target.favoriteAt, context)),
    {
      label: 'Delete…',
      danger: true,
      run: () => {
        if (!context.confirm(`Delete “${context.title(path)}”? This cannot be undone here.`)) {
          return;
        }
        later(actions.remove(path, { wasOpen: path === context.activePath }));
      },
    },
  ];
}
