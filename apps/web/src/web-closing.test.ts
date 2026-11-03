import { describe, expect, it, vi } from 'vitest';
import { webClosing, writeWhenHidden } from './web-closing.ts';

describe('webClosing', () => {
  it('runs every task, and hands back each failure rather than swallowing it', async () => {
    const closing = webClosing();
    const ran: string[] = [];
    await closing.beforeClose(async () => void ran.push('first'));
    await closing.beforeClose(async () => Promise.reject(new Error('the disk is full')));
    const stop = await closing.beforeClose(async () => void ran.push('stopped'));
    stop();
    await closing.beforeClose(async () => void ran.push('last'));
    expect(await closing.close()).toEqual([new Error('the disk is full')]);
    expect(ran).toEqual(['first', 'last']);
  });
});

describe('writeWhenHidden', () => {
  function page() {
    const events = new EventTarget();
    const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    const reportError = vi.fn();
    return Object.assign(events, { document, reportError });
  }

  it('writes what waits as the page is hidden or put away, reporting what failed, until stopped', async () => {
    const shown = page();
    const close = vi.fn(async () => [new Error('the disk is full')] as const);
    const stop = writeWhenHidden(shown as never, { close });
    shown.dispatchEvent(new Event('pagehide'));
    shown.document.visibilityState = 'visible';
    shown.document.dispatchEvent(new Event('visibilitychange'));
    shown.document.visibilityState = 'hidden';
    shown.document.dispatchEvent(new Event('visibilitychange'));
    expect(close).toHaveBeenCalledTimes(2);
    await vi.waitFor(() =>
      expect(shown.reportError).toHaveBeenCalledWith(new Error('the disk is full')),
    );
    stop();
    shown.dispatchEvent(new Event('pagehide'));
    expect(close).toHaveBeenCalledTimes(2);
  });
});
