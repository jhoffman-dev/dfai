import {
  deleteNote,
  openVault,
  saveNoteText,
  VaultSession,
  type SyncScheduler,
  type SyncStatus,
} from '../application/index.ts';
import { MemoryNoteStore } from '../application/testing/index.ts';
import { connectSync } from './sync-controls.ts';

const PLAN = 'Projects/Larkspur Payroll.md';
const COPY = 'Projects/Larkspur Payroll (conflict 2026-11-21).md';
const IDLE: SyncStatus = { phase: 'idle', conflicts: 0, lastSyncedAt: null, message: null };

class FakeScheduler implements SyncScheduler {
  current = IDLE;
  pushes = 0;
  wakes = 0;
  private listeners = new Set<(status: SyncStatus) => void>();
  start = async () => undefined;
  stop = () => undefined;
  noteChanged = () => {
    this.pushes += 1;
  };
  wake = async () => {
    this.wakes += 1;
  };
  status = () => this.current;
  subscribe(listener: (status: SyncStatus) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  publish(next: Partial<SyncStatus>) {
    this.current = { ...this.current, ...next };
    for (const listener of this.listeners) listener(this.current);
  }
}

class FakePage {
  visible = true;
  private listeners = new Map<string, () => void>();
  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, listener);
  }
  isVisible = () => this.visible;
  fire(type: string) {
    this.listeners.get(type)?.();
  }
}

async function setup(files: Record<string, string> = { [PLAN]: 'Parallel run.' }) {
  const store = MemoryNoteStore.of(files);
  const session = new VaultSession();
  await openVault({ store, session });
  const scheduler = new FakeScheduler();
  const page = new FakePage();
  const controls = connectSync({ scheduler, session, page });
  return { deps: { store, session }, session, scheduler, page, controls };
}

describe('sync wired to the vault', () => {
  it('asks for a push when a note is edited here, not when sync pulls one', async () => {
    const { deps, session, scheduler } = await setup();
    await saveNoteText(deps, { path: PLAN, text: 'Edited here.' });
    expect(scheduler.pushes).toBe(1);
    session.applyWrite({ path: PLAN, text: 'Pulled.', baseSha: 'abc', dirty: false });
    expect(scheduler.pushes).toBe(1);
  });

  it('leaves a delete made by a running sync alone, but pushes one made by hand', async () => {
    const { deps, session, scheduler } = await setup();
    scheduler.publish({ phase: 'syncing' });
    session.applyDelete(PLAN);
    expect(scheduler.pushes).toBe(0);
    scheduler.publish({ phase: 'idle' });
    await saveNoteText(deps, { path: 'Welcome.md', text: 'Hello.' });
    await deleteNote(deps, { path: 'Welcome.md' });
    expect(scheduler.pushes).toBe(2);
  });

  it('counts the conflict copies still in the vault, as they come and go', async () => {
    const { deps, session, controls } = await setup({ [PLAN]: 'a', [COPY]: 'b' });
    expect(controls.getStatus()).toEqual({ kind: 'conflicts', count: 1, lastSyncedAt: null });
    session.applyDelete(COPY);
    expect(controls.getStatus()).toEqual({ kind: 'idle', lastSyncedAt: null });
    await saveNoteText(deps, { path: COPY, text: 'again' });
    expect(controls.getStatus()).toMatchObject({ kind: 'conflicts', count: 1 });
  });

  it('shows why sync stopped, and tells listeners', async () => {
    const { scheduler, controls } = await setup();
    const heard = vi.fn();
    controls.subscribe(heard);
    scheduler.publish({ phase: 'error', message: 'The branch main is gone from GitHub.' });
    expect(controls.getStatus()).toEqual({
      kind: 'error',
      message: 'The branch main is gone from GitHub.',
    });
    scheduler.publish({ phase: 'needs-sign-in', message: 'Bad credentials' });
    expect(controls.getStatus()).toEqual({ kind: 'needs-sign-in' });
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it('syncs on coming back online, into view, and on Sync now', async () => {
    const { scheduler, page, controls } = await setup();
    page.fire('online');
    page.visible = false;
    page.fire('visibilitychange');
    page.visible = true;
    page.fire('visibilitychange');
    controls.syncNow();
    expect(scheduler.wakes).toBe(3);
  });
});
