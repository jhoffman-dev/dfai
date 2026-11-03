import { describe, expect, it } from 'vitest';
import { webClosing } from './web-closing.ts';

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
