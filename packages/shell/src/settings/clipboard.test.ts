// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserClipboard } from './clipboard.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('browserClipboard', () => {
  it('puts the text on the webview’s clipboard', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await browserClipboard.write('Could not save.');
    expect(writeText).toHaveBeenCalledWith('Could not save.');
  });

  it('refuses, and does not throw, where the webview has no clipboard (plain http)', async () => {
    vi.stubGlobal('navigator', { clipboard: undefined });
    const written = (() => browserClipboard.write('Could not save.'))();
    await expect(written).rejects.toThrow();
  });

  it('passes on the clipboard’s own refusal', async () => {
    const denied = new Error('denied');
    vi.stubGlobal('navigator', { clipboard: { writeText: () => Promise.reject(denied) } });
    await expect(browserClipboard.write('Could not save.')).rejects.toBe(denied);
  });
});
