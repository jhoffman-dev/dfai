import { describe, expect, it, vi } from 'vitest';
import {
  registerShellWorker,
  WORKER_PATH,
  type InstallingWorker,
  type UpdateReady,
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
function fakeContainer({
  controlled,
  whileRegistering = () => {},
}: {
  controlled: boolean;
  /** Runs before `register` resolves: the browser may get far with the worker in that time. */
  whileRegistering?: () => void;
}) {
  const updates = new Set<() => void>();
  const controller = new Set<() => void>();
  const registration = {
    installing: null as InstallingWorker | null,
    waiting: null as InstallingWorker | null,
    addEventListener: (_type: 'updatefound', listener: () => void) => updates.add(listener),
  } satisfies WorkerRegistration;
  const registered: string[] = [];
  const workers: WorkerContainer & {
    controller: Pick<ServiceWorker, 'state'> | null;
    registered: string[];
    claimed: () => void;
    takeOver: () => void;
  } = {
    controller: controlled ? { state: 'activated' } : null,
    register: async (path) => {
      registered.push(path);
      whileRegistering();
      return registration;
    },
    addEventListener: (_type, listener) => controller.add(listener),
    registered,
    // The browser sets the controller in parallel and only queues `controllerchange`, so the
    // page can read the new controller before the event that announces it (#762).
    claimed: () => (workers.controller = { state: 'activated' }),
    takeOver: () => {
      workers.claimed();
      controller.forEach((listener) => listener());
    },
  };
  /** A newer build's worker found and installing. */
  const update = (worker: InstallingWorker) => {
    registration.installing = worker;
    updates.forEach((listener) => listener());
  };
  /** The installing worker done: waiting behind the one in control. */
  const installed = (worker: ReturnType<typeof fakeWorker>) => {
    registration.installing = null;
    registration.waiting = worker;
    worker.becomes('installed');
  };
  /** The waiting worker took over, as it does once told to skip waiting (by this tab or another). */
  const activated = (worker: ReturnType<typeof fakeWorker>) => {
    registration.waiting = null;
    worker.becomes('activating');
    worker.becomes('activated');
    workers.takeOver();
  };
  return { workers, registration, update, installed, activated };
}

/** Whether a promise has settled by now: checked after a turn of the microtask queue. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => (done = true));
  await Promise.resolve();
  await Promise.resolve();
  return done;
}

const offered = (onUpdateReady: ReturnType<typeof vi.fn>): UpdateReady => {
  const [offer] = onUpdateReady.mock.calls[0] as [UpdateReady];
  return offer;
};

describe('registering the shell worker (#668)', () => {
  it('registers the worker at the site root, so its scope is the whole site', async () => {
    const { workers } = fakeContainer({ controlled: false });
    await registerShellWorker({ workers, onUpdateReady: vi.fn() });
    expect(workers.registered).toEqual([WORKER_PATH]);
    expect(WORKER_PATH).toBe('/sw.js');
  });

  it('says Update ready once a newer worker has installed behind the controlling one', async () => {
    const { workers, update, installed } = fakeContainer({ controlled: true });
    const onUpdateReady = vi.fn();
    await registerShellWorker({ workers, onUpdateReady });
    const next = fakeWorker();
    update(next);
    expect(onUpdateReady).not.toHaveBeenCalled();
    installed(next);
    expect(onUpdateReady).toHaveBeenCalledTimes(1);
  });

  it('says nothing on the first visit, when the first worker installs with no controller', async () => {
    const { workers, update, installed, activated } = fakeContainer({ controlled: false });
    const onUpdateReady = vi.fn();
    await registerShellWorker({ workers, onUpdateReady });
    const first = fakeWorker();
    update(first);
    installed(first);
    activated(first);
    expect(onUpdateReady).not.toHaveBeenCalled();
  });

  it('says nothing on the first visit when the first worker claims the page while it registers (#762)', async () => {
    const { workers } = fakeContainer({
      controlled: false,
      whileRegistering: () => workers.claimed(),
    });
    const onUpdateReady = vi.fn();
    await registerShellWorker({ workers, onUpdateReady });
    // The claim's queued `controllerchange` reaches the page only now.
    workers.takeOver();
    expect(onUpdateReady).not.toHaveBeenCalled();
  });

  it('says nothing on the first visit when the claim lands before the page hears the worker installed (#762)', async () => {
    const { workers, registration } = fakeContainer({ controlled: false });
    const onUpdateReady = vi.fn();
    const first = fakeWorker();
    registration.installing = first;
    await registerShellWorker({ workers, onUpdateReady });
    // The worker raced through activation and claimed; its queued `installed` is dispatched after.
    workers.claimed();
    first.becomes('installed');
    first.becomes('activating');
    first.becomes('activated');
    workers.takeOver();
    expect(onUpdateReady).not.toHaveBeenCalled();
  });

  it('says nothing on the first visit when updatefound reaches the page after the claim (#762)', async () => {
    const { workers, update } = fakeContainer({ controlled: false });
    const onUpdateReady = vi.fn();
    await registerShellWorker({ workers, onUpdateReady });
    const first = fakeWorker();
    workers.claimed();
    update(first);
    first.becomes('installed');
    first.becomes('activated');
    workers.takeOver();
    expect(onUpdateReady).not.toHaveBeenCalled();
  });

  it('says nothing to a page that opened uncontrolled, though a claim and a waiting worker show by the time it registers (#762)', async () => {
    const { workers, registration } = fakeContainer({
      controlled: false,
      whileRegistering: () => {
        workers.claimed();
        registration.waiting = fakeWorker('installed');
      },
    });
    const onUpdateReady = vi.fn();
    await registerShellWorker({ workers, onUpdateReady });
    expect(onUpdateReady).not.toHaveBeenCalled();
  });

  it('still offers a newer build to a tab that its first worker claimed (#762)', async () => {
    const { workers, update, installed } = fakeContainer({ controlled: false });
    const onUpdateReady = vi.fn();
    await registerShellWorker({ workers, onUpdateReady });
    workers.takeOver();
    const next = fakeWorker();
    update(next);
    installed(next);
    expect(onUpdateReady).toHaveBeenCalledTimes(1);
  });

  it('offers a worker already waiting when the page opens, as after a deploy seen by another tab', async () => {
    const { workers, registration } = fakeContainer({ controlled: true });
    registration.waiting = fakeWorker('installed');
    const onUpdateReady = vi.fn();
    await registerShellWorker({ workers, onUpdateReady });
    expect(onUpdateReady).toHaveBeenCalledTimes(1);
  });

  it('on Reload, tells the waiting worker to take over, and is done once it controls the page', async () => {
    const { workers, update, installed, activated } = fakeContainer({ controlled: true });
    const onUpdateReady = vi.fn();
    await registerShellWorker({ workers, onUpdateReady });
    const next = fakeWorker();
    update(next);
    installed(next);
    const taking = offered(onUpdateReady).takeOver();
    expect(next.messages).toEqual([SKIP_WAITING]);
    expect(await settled(taking)).toBe(false);
    activated(next);
    expect(await settled(taking)).toBe(true);
  });

  it('on Reload after another tab already had the worker take over, is done at once: the page is already its', async () => {
    const { workers, update, installed, activated } = fakeContainer({ controlled: true });
    const onUpdateReady = vi.fn();
    await registerShellWorker({ workers, onUpdateReady });
    const next = fakeWorker();
    update(next);
    installed(next);
    // The other tab's Reload: this tab is told of the change, but did not ask for it.
    activated(next);
    const taking = offered(onUpdateReady).takeOver();
    expect(next.messages).toEqual([]);
    expect(await settled(taking)).toBe(true);
  });

  it('on Reload while the worker another tab asked for is still activating, is done at once, asking nothing more', async () => {
    const { workers, registration, update, installed } = fakeContainer({ controlled: true });
    const onUpdateReady = vi.fn();
    await registerShellWorker({ workers, onUpdateReady });
    const next = fakeWorker();
    update(next);
    installed(next);
    // The other tab's Reload is under way: the worker is activating, not yet in control here.
    next.becomes('activating');
    expect(registration.waiting).toBe(next);
    const taking = offered(onUpdateReady).takeOver();
    expect(next.messages).toEqual([]);
    expect(await settled(taking)).toBe(true);
  });

  it('keeps the one bar through a takeover it did not ask for, so this tab can still reload safely', async () => {
    const { workers, update, installed, activated } = fakeContainer({ controlled: true });
    const onUpdateReady = vi.fn();
    await registerShellWorker({ workers, onUpdateReady });
    const next = fakeWorker();
    update(next);
    installed(next);
    activated(next);
    // Still the one offer: the bar is up, not doubled, not taken down.
    expect(onUpdateReady).toHaveBeenCalledTimes(1);
  });

  it('shows the bar on a takeover it was never offered: the shell under it is no longer the one it loaded', async () => {
    const { workers, update, activated } = fakeContainer({ controlled: true });
    const onUpdateReady = vi.fn();
    await registerShellWorker({ workers, onUpdateReady });
    // Another tab's Reload went through before this tab saw the worker installed.
    const next = fakeWorker('activating');
    update(next);
    activated(next);
    expect(onUpdateReady).toHaveBeenCalledTimes(1);
    expect(await settled(offered(onUpdateReady).takeOver())).toBe(true);
  });

  it('hands registration failing to the caller, who leaves the app as it was', async () => {
    const workers: WorkerContainer = {
      controller: null,
      register: () => Promise.reject(new Error('SecurityError: not allowed here')),
      addEventListener: vi.fn(),
    };
    await expect(registerShellWorker({ workers, onUpdateReady: vi.fn() })).rejects.toThrow(
      'not allowed here',
    );
  });
});
