import { afterEach, describe, expect, it } from 'vitest';
import { indexHostOver, serveIndexHost, type IndexEndpoint } from './index-channel.ts';
import type { WasmIndexHost } from './wasm-index-host.ts';
import { webIndexPort } from './web-index-port.ts';

/** The window's index calls, over a real MessageChannel to a host on its other end (#666). */

const channels: MessageChannel[] = [];
afterEach(() => {
  for (const { port1, port2 } of channels.splice(0)) {
    port1.close();
    port2.close();
  }
});

function over(host: Partial<WasmIndexHost>, made = { count: 0 }) {
  const channel = new MessageChannel();
  channels.push(channel);
  serveIndexHost(channel.port1 as IndexEndpoint, async () => {
    made.count++;
    return host as WasmIndexHost;
  });
  channel.port1.start();
  channel.port2.start();
  return { calls: indexHostOver(channel.port2 as IndexEndpoint), port: channel.port2, made };
}

describe('the index channel (#666)', () => {
  it('answers each call with what the host gave, cloned across', async () => {
    const { calls } = over({
      manifest: () => [{ path: 'A.md', modified: 1, size: 2, digest: 'd', type: null }],
    });
    expect(await calls.manifest()).toEqual([
      { path: 'A.md', modified: 1, size: 2, digest: 'd', type: null },
    ]);
  });

  it('turns what the host threw into a refusal with its message', async () => {
    const { calls } = over({
      stats: () => {
        throw new Error('the index is not open');
      },
    });
    await expect(calls.stats()).rejects.toThrow('the index is not open');
  });

  it('makes the host once, on the first call, and answers calls in the order they came', async () => {
    const order: string[] = [];
    const made = { count: 0 };
    const { calls } = over(
      {
        clear: () => void order.push('clear'),
        stats: () => (order.push('stats'), { notes: 0, properties: 0, links: 0 }),
      },
      made,
    );
    expect(made.count).toBe(0);
    await Promise.all([calls.clear(), calls.stats(), calls.clear()]);
    expect(order).toEqual(['clear', 'stats', 'clear']);
    expect(made.count).toBe(1);
  });

  it('leaves alone a message that is no call it knows', async () => {
    const { port, calls } = over({ stats: () => ({ notes: 1, properties: 0, links: 0 }) });
    port.postMessage({ id: 99, call: 'drop everything', args: [] });
    expect(await calls.stats()).toEqual({ notes: 1, properties: 0, links: 0 });
  });

  it('opens the vault open now, and refuses to open with none', async () => {
    const opened: string[] = [];
    const { calls } = over({ open: (vault) => (opened.push(vault), { fresh: true }) });
    let vault: string | null = null;
    const index = webIndexPort({ host: () => calls, openVault: () => vault });
    await expect(index.open()).rejects.toThrow('no vault is open');
    vault = 'github:example/garden';
    expect(await index.open()).toEqual({ fresh: true });
    expect(opened).toEqual(['github:example/garden']);
  });
});

describe('the index channel when the host or the worker fails (#666)', () => {
  it('makes the host again on the next call when making it failed: a second tab can retry', async () => {
    const channel = new MessageChannel();
    channels.push(channel);
    let attempts = 0;
    serveIndexHost(channel.port1 as IndexEndpoint, async () => {
      attempts++;
      if (attempts === 1) throw new Error('the pool is held by another tab');
      return { stats: () => ({ notes: 3, properties: 0, links: 0 }) } as unknown as WasmIndexHost;
    });
    channel.port1.start();
    channel.port2.start();
    const calls = indexHostOver(channel.port2 as IndexEndpoint);
    await expect(calls.stats()).rejects.toThrow('the pool is held by another tab');
    expect(await calls.stats()).toEqual({ notes: 3, properties: 0, links: 0 });
    expect(attempts).toBe(2);
  });

  it('refuses every waiting call, and every later one, when the worker fails to load', async () => {
    const worker = new EventTarget() as EventTarget & IndexEndpoint;
    const posted: unknown[] = [];
    worker.postMessage = (message) => void posted.push(message);
    const calls = indexHostOver(worker);
    const waiting = [calls.stats(), calls.manifest()];
    worker.dispatchEvent(new Event('error'));
    for (const call of waiting) await expect(call).rejects.toThrow(/the index worker failed/);
    await expect(calls.stats()).rejects.toThrow(/the index worker failed/);
    expect(posted).toHaveLength(2);
  });

  it('refuses the waiting calls when an answer cannot be read', async () => {
    const worker = new EventTarget() as EventTarget & IndexEndpoint;
    worker.postMessage = () => undefined;
    const calls = indexHostOver(worker);
    const waiting = calls.stats();
    worker.dispatchEvent(new Event('messageerror'));
    await expect(waiting).rejects.toThrow(/could not be read/);
  });
});
