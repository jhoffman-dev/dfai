import { describe, expect, it } from 'vitest';
import { createVaultPath } from '../vault/vault-path.ts';
import { assistLinksBrokenByMoveBack } from './assist-links.ts';

/** #911: which wiki links moving an item back from where it was filed would leave opening nothing. */

const FROM = createVaultPath('Inbox/Call Mara.md');
const TO = createVaultPath('Tasks/2026/11/Call Mara.md');
const SAME = createVaultPath('Reference/Call Mara.md');
const notePaths = [TO, SAME, createVaultPath('Notes/Week.md')];
const broken = (text: string, ignoring: string[] = []) =>
  assistLinksBrokenByMoveBack({
    notes: [{ path: createVaultPath('Notes/Week.md'), text }],
    from: FROM,
    to: TO,
    notePaths,
    ignoring: new Set(ignoring),
  });

describe('assistLinksBrokenByMoveBack', () => {
  it('finds a link by the path it was filed at, with or without an alias or heading', () => {
    for (const text of [
      'See [[Tasks/2026/11/Call Mara]].',
      'See [[Tasks/2026/11/Call Mara|the call]].',
      'See [[Tasks/2026/11/Call Mara#Notes]].',
    ]) {
      expect(broken(text), text).toEqual(['Notes/Week.md']);
    }
  });

  it('leaves a link by its title, which opens it where it goes back to', () => {
    expect(broken('See [[Call Mara]].')).toEqual([]);
  });

  it('leaves links to another note, a link in code, and a note the undo puts back itself', () => {
    expect(broken('See [[Reference/Call Mara]].')).toEqual([]);
    expect(broken('`[[Tasks/2026/11/Call Mara]]`')).toEqual([]);
    expect(broken('See [[Tasks/2026/11/Call Mara]].', ['Notes/Week.md'])).toEqual([]);
  });

  it('finds nothing for an item that never moved', () => {
    expect(
      assistLinksBrokenByMoveBack({
        notes: [{ path: SAME, text: `[[${FROM}]]` }],
        from: FROM,
        to: FROM,
        notePaths,
        ignoring: new Set(),
      }),
    ).toEqual([]);
  });
});
