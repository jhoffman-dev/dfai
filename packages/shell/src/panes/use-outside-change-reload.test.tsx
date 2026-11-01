// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createVaultPath, digestOf, type NoteChange } from '@dfai/domain';
import { createNoteChanges, type OpenNote } from '@dfai/application';
import { useOutsideChangeReload, type ReloadableNote } from './use-outside-change-reload.ts';

const VAULT = '/Users/someone/Vault';
const PATH = createVaultPath('Plan.md');
const ON_DISK = '# Plan\n\nAs read.\n';

const held = (overrides: Partial<ReloadableNote> = {}) => {
  const reload = vi.fn();
  const open = { path: PATH, onDisk: ON_DISK, modified: 1 } as unknown as OpenNote;
  const live = { current: { open, dirty: false, reload, ...overrides } };
  return { live, reload };
};

const changed = (text: string, path = PATH): NoteChange =>
  ({ kind: 'changed', path, digest: digestOf(text), type: null }) as NoteChange;

function listen(live: { current: ReloadableNote }, vault: string | null = VAULT) {
  const changes = createNoteChanges({ onError: () => {} });
  renderHook(() => useOutsideChangeReload({ changes, vault, path: PATH, live }));
  return changes;
}

describe('useOutsideChangeReload', () => {
  it('reads a clean editor again when its note changed to another digest', () => {
    const { live, reload } = held();
    const changes = listen(live);
    changes.publish({ vault: VAULT, changes: [changed('# Plan\n\nTheirs.\n')] });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('leaves a dirty editor its edits', () => {
    const { live, reload } = held({ dirty: true });
    const changes = listen(live);
    changes.publish({ vault: VAULT, changes: [changed('# Plan\n\nTheirs.\n')] });
    expect(reload).not.toHaveBeenCalled();
  });

  it('takes the echo of its own write, the same digest, as no change', () => {
    const { live, reload } = held();
    const changes = listen(live);
    changes.publish({ vault: VAULT, changes: [changed(ON_DISK)] });
    expect(reload).not.toHaveBeenCalled();
  });

  it('ignores news of another vault, and of another note, and of a removal', () => {
    const { live, reload } = held();
    const changes = listen(live);
    changes.publish({ vault: '/Users/someone/Other', changes: [changed('# Plan\n\nTheirs.\n')] });
    changes.publish({ vault: VAULT, changes: [changed('Other.', createVaultPath('Other.md'))] });
    changes.publish({
      vault: VAULT,
      changes: [{ kind: 'removed', path: PATH, digest: 'x', type: null } as NoteChange],
    });
    expect(reload).not.toHaveBeenCalled();
  });
});
