import { describe, expect, it } from 'vitest';
import { createVaultPath } from '@dfai/domain';
import { automationVault, jsonNote } from '../testing/automation-vault.ts';
import { changeProperties, type PropertyChange } from './apply-changes.ts';

const NOTE = createVaultPath('Inbox/Meetings/2026-10-06 Standup.md');
const TODAY = '2026-10-06';

const vaultOf = (properties: Record<string, unknown>) =>
  automationVault({ notes: { [NOTE]: jsonNote(properties) }, today: TODAY });

const mark: PropertyChange = {
  path: NOTE,
  key: 'atlas_links',
  expect: { value: 'failed' },
  to: { absent: true },
  alongside: true,
};
const people = (expect: PropertyChange['expect']): PropertyChange => ({
  path: NOTE,
  key: 'people',
  expect,
  to: { value: ['[[Mara Quill]]'] },
});

describe('a change that only rides alongside (#192)', () => {
  it('is written with the others, in the one write', async () => {
    const vault = vaultOf({ type: 'meeting', atlas_links: 'failed' });

    const outcome = await changeProperties({
      ports: vault.ports,
      changes: [mark, people({ absent: true })],
      kind: 'set',
      today: TODAY,
    });

    expect(vault.properties(NOTE)).toEqual({ type: 'meeting', people: ['[[Mara Quill]]'] });
    expect(outcome.done.map((line) => ('key' in line ? line.key : null))).toEqual([
      'people',
      'atlas_links',
    ]);
  });

  it('is not written when every other change was left', async () => {
    const vault = vaultOf({ type: 'meeting', atlas_links: 'failed', people: ['[[Tobias Fenn]]'] });

    const outcome = await changeProperties({
      ports: vault.ports,
      changes: [mark, people({ absent: true })],
      kind: 'set',
      today: TODAY,
    });

    expect(vault.properties(NOTE)['atlas_links']).toBe('failed');
    expect(outcome.done).toEqual([]);
    expect(outcome.left).toHaveLength(1);
  });

  it('is not written on its own', async () => {
    const vault = vaultOf({ type: 'meeting', atlas_links: 'failed' });

    const outcome = await changeProperties({
      ports: vault.ports,
      changes: [mark],
      kind: 'set',
      today: TODAY,
    });

    expect(vault.properties(NOTE)['atlas_links']).toBe('failed');
    expect(outcome).toEqual({ done: [], left: [] });
  });
});
