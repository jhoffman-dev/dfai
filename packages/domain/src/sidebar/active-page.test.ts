import { describe, expect, it } from 'vitest';
import { createVaultPath } from '../vault/vault-path.ts';
import type { NavigationPlace } from '../panes/index.ts';
import { activeSidebarPageOf } from './index.ts';

const acme = createVaultPath('Acme.md');
const board = createVaultPath('.atlas/views/Board.md');

describe('activeSidebarPageOf', () => {
  const viewOwner = (path: string) => (path === board ? 'task' : null);

  it('is nothing for an empty tab', () => {
    expect(activeSidebarPageOf(null, viewOwner)).toBeNull();
  });

  it('is the note the tab shows', () => {
    expect(activeSidebarPageOf({ kind: 'note', path: acme }, viewOwner)).toEqual({
      kind: 'note',
      path: acme,
    });
  });

  it('is the type whose view the tab shows: a type owns its views', () => {
    expect(activeSidebarPageOf({ kind: 'note', path: board }, viewOwner)).toEqual({
      kind: 'type',
      name: 'task',
    });
  });

  it('is the type a tab is on', () => {
    expect(activeSidebarPageOf({ kind: 'type', name: 'person' }, viewOwner)).toEqual({
      kind: 'type',
      name: 'person',
    });
  });

  it('is the page a tab is on, whichever tag or scope it holds', () => {
    const pages: readonly [NavigationPlace, string][] = [
      [{ kind: 'graph', scope: { kind: 'vault' } }, 'graph'],
      [{ kind: 'graph', scope: { kind: 'note', path: acme, depth: 1 } }, 'graph'],
      [{ kind: 'tags', tag: null }, 'tags'],
      [{ kind: 'tags', tag: 'urgent' }, 'tags'],
      [{ kind: 'archive' }, 'archive'],
      [{ kind: 'inbox' }, 'inbox'],
      [{ kind: 'review' }, 'review'],
      [{ kind: 'today' }, 'today'],
      [{ kind: 'automations' }, 'automations'],
      [{ kind: 'activity' }, 'activity'],
      [{ kind: 'templates' }, 'templates'],
      [{ kind: 'terms' }, 'terms'],
      [{ kind: 'skills' }, 'skills'],
      [{ kind: 'ask' }, 'ask'],
    ];
    for (const [place, kind] of pages) {
      expect(activeSidebarPageOf(place, viewOwner)).toEqual({ kind });
    }
  });

  it('marks nothing for the query page, which has no sidebar row', () => {
    expect(activeSidebarPageOf({ kind: 'query' }, viewOwner)).toBeNull();
  });
});
