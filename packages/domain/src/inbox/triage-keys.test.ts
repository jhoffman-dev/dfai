import { describe, expect, it } from 'vitest';
import { GTD_STATUSES } from '../gtd/gtd-status.ts';
import { TRIAGE_KEYS, triageActionOf, triageKeysOf } from './triage-keys.ts';

/** #109, #307 (Q11): one key on a focused Inbox row — N/W/S/D write the status alone, P and T open a picker. */

describe('triageActionOf', () => {
  it('maps N, W, S and D to the status each writes, and nothing else', () => {
    expect(triageActionOf('n')).toEqual({ kind: 'status', status: 'next-action' });
    expect(triageActionOf('w')).toEqual({ kind: 'status', status: 'waiting' });
    expect(triageActionOf('s')).toEqual({ kind: 'status', status: 'someday' });
    expect(triageActionOf('d')).toEqual({ kind: 'status', status: 'archive' });
  });

  it('maps P to the project picker and T to the defer date, which write once picked', () => {
    expect(triageActionOf('p')).toEqual({ kind: 'pick', field: 'project' });
    expect(triageActionOf('t')).toEqual({ kind: 'pick', field: 'defer' });
  });

  it('reads X as D: X ticks done on Today, so it finishes an Inbox row too (#109)', () => {
    expect(triageActionOf('x')).toEqual({ kind: 'status', status: 'archive' });
    expect(triageActionOf('X')).toEqual(triageActionOf('d'));
    expect(
      triageActionOf(
        'x',
        GTD_STATUSES.filter((status) => status !== 'archive'),
      ),
    ).toBeNull();
  });

  it('names every key that does what a listed key does: D and X finish, P is P alone', () => {
    expect(triageKeysOf('d')).toEqual(['d', 'x']);
    expect(triageKeysOf('p')).toEqual(['p']);
  });

  it('reads the key whatever its case: Shift held is still the key', () => {
    expect(triageActionOf('N')).toEqual(triageActionOf('n'));
    expect(triageActionOf('P')).toEqual(triageActionOf('p'));
  });

  it('refuses a key it does not know: another letter, a digit, or a named key', () => {
    for (const key of ['l', 'u', 'j', '1', ' ', '', 'Enter', 'Tab', 'nn', 'ArrowDown']) {
      expect(triageActionOf(key), key).toBeNull();
    }
  });

  it('has no key for Longterm, Backlog, In Progress or Inbox: the row’s picker still offers them', () => {
    const written = TRIAGE_KEYS.flatMap(({ action }) =>
      action.kind === 'status' ? [action.status] : [],
    );
    expect(written).toEqual(['next-action', 'waiting', 'someday', 'archive']);
  });

  it('refuses a status the vault’s Task type does not declare, and still offers the pickers', () => {
    const declared = GTD_STATUSES.filter((status) => status !== 'someday');
    expect(triageActionOf('s', declared)).toBeNull();
    expect(triageActionOf('n', declared)).toEqual({ kind: 'status', status: 'next-action' });
    expect(triageActionOf('p', [])).toEqual({ kind: 'pick', field: 'project' });
    expect(triageActionOf('t', [])).toEqual({ kind: 'pick', field: 'defer' });
  });

  it('lists the keys in the order the row shows them: Next, Waiting, Someday, Schedule, Project, Done', () => {
    expect(TRIAGE_KEYS.map(({ key }) => key)).toEqual(['n', 'w', 's', 't', 'p', 'd']);
  });

  it('agrees with the table: every listed key gives its own action', () => {
    for (const { key, action } of TRIAGE_KEYS) expect(triageActionOf(key)).toEqual(action);
  });
});
