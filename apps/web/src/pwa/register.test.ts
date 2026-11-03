import { describe, expect, it, vi } from 'vitest';
import {
  registerShellWorker,
  WORKER_PATH,
  type InstallingWorker,
  type WorkerContainer,
  type WorkerRegistration,
} from './register.ts';
import { SKIP_WAITING } from './shell-rules.ts';

/** A worker the browser is installing: its state is set by the test, and `statechange` follows. */
function fakeWorker(state = 'installing') {
  const listeners = new Set<() => void>();
  const worker = {
    state,
    messages: [] as unknown[],
    postMessage: (message: unknown) => worker.messages.push(message),
    addEventListener: (_type: 'statechange', listener: () => void) => listeners.add(listener),
    becomes: (next: string) => {
      worker.state = next;
      listeners.forEach((listener) => listener());
    },
  };
  return worker satisfies InstallingWorker & Record<string, unknown>;
}

/** `navigator.serviceWorker` as the test drives it: a registration whose workers the test installs. */
function fakeContainer({ controlled }: { controlled: boolean }) {
  const updates = new Set<() => void>();
  const controller = new Set<() => void>();
  const registration = {
    installing: null as InstallingWorker | null,
    waiting: null as InstallingWorker | null,
    addEventListener: (_type: 'updatefound', listener: () => void) => updates.add(listener),
  } satisfies WorkerRegistration;
  const registered: string[] = [];
  const workers: WorkerContainer & { registered: string[]; takeOver: () => void } = {
    controller: controlled ? { state: 'activated' } : null,
    register: async (path) => {
      registered.push(path);
      return registration;
    },
    addEventListener: (_type, listener) => controller.add(listener),
    registered,
    takeOver: () => controller.forEach((listener) => listener()),
  };
  const update = (worker: InstallingWorker) => {
    registration.installing = worker;
    updates.forEach((listener) => listener());
  };
  return { workers, registration, update };
}

describe('registering the shell worker (#668)', () => {
  it('registers the worker at the site root, so its scope is the whole site', async () => {
    const { workers } = fakeContainer({ controlled: false });
    await registerShellWorker({ workers, onUpdateReady: vi.fn(), reloadPage: vi.fn() });
    expect(workers.registered).toEqual([WORKER_PATH]);
    expect(WORKER_PATH).toBe('/sw.js');
  });

  it('says Update ready once a newer worker has installed behind the controlling one', async () => {
    const { workers, update } = fakeContainer({ controlled: true });
    const onUpdateReady = vi.fn();
    await registerShellWorker({ workers, onUpdateReady, reloadPage: vi.fn() });
    const next = fakeWorker();
    update(next);
    expect(onUpdateReady).not.toHaveBeenCalled();
    next.becomes('installed');
    expect(onUpdateReady).toHaveBeenCalledTimes(1);
  });

  it('says nothing on the first visit, when the first worker installs with no controller', async () => {
    const { workers, update } = fakeContainer({ controlled: false });
    const onUpdateReady = vi.fn();
    await registerShellWorker({ workers, onUpdateReady, reloadPage: vi.fn() });
    const first = fakeWorker();
    update(first);
    first.becomes('installed');
    expect(onUpdateReady).not.toHaveBeenCalled();
  });

  it('offers a worker already waiting when the page opens, as after a deploy seen by another tab', async () => {
    const { workers, registration } = fakeContainer({ controlled: true });
    registration.waiting = fakeWorker('installed');
    const onUpdateReady = vi.fn();
    await registerShellWorker({ workers, onUpdateReady, reloadPage: vi.fn() });
    expect(onUpdateReady).toHaveBeenCalledTimes(1);
  });

  it('on Reload, tells the waiting worker to take over, and reloads the page once it has', async () => {
    const { workers, update } = fakeContainer({ controlled: true });
    const reloadPage = vi.fn();
    const onUpdateReady = vi.fn();
    await registerShellWorker({ workers, onUpdateReady, reloadPage });
    const next = fakeWorker();
    update(next);
    next.becomes('installed');
    const [offer] = onUpdateReady.mock.calls[0] as [{ reload: () => void }];
    offer.reload();
    expect(next.messages).toEqual([SKIP_WAITING]);
    expect(reloadPage).not.toHaveBeenCalled();
    workers.takeOver();
    expect(reloadPage).toHaveBeenCalledTimes(1);
  });

  it('does not reload when the first worker claims the page as it activates', async () => {
    const { workers, update } = fakeContainer({ controlled: false });
    const reloadPage = vi.fn();
    await registerShellWorker({ workers, onUpdateReady: vi.fn(), reloadPage });
    const first = fakeWorker();
    update(first);
    first.becomes('installed');
    first.becomes('activated');
    workers.takeOver();
    expect(reloadPage).not.toHaveBeenCalled();
  });

  it('hands registration failing to the caller, who leaves the app as it was', async () => {
    const workers: WorkerContainer = {
      controller: null,
      register: () => Promise.reject(new Error('SecurityError: not allowed here')),
      addEventListener: vi.fn(),
    };
    await expect(
      registerShellWorker({ workers, onUpdateReady: vi.fn(), reloadPage: vi.fn() }),
    ).rejects.toThrow('not allowed here');
  });
});
