// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserChatSettingsStore } from './chat-settings-store.ts';

describe('the chat settings store', () => {
  beforeEach(() => window.localStorage.clear());

  it('starts on Claude Code with the default model', () => {
    expect(createBrowserChatSettingsStore().read()).toEqual({ provider: 'claude-code', model: '' });
  });

  it('remembers a choice across stores, as the next launch would read it', () => {
    createBrowserChatSettingsStore().write({ provider: 'anthropic-api', model: 'claude-sonnet-5' });
    expect(createBrowserChatSettingsStore().read()).toEqual({
      provider: 'anthropic-api',
      model: 'claude-sonnet-5',
    });
  });

  it('reads anything unexpected as the default', () => {
    window.localStorage.setItem('atlas.chat', '{"provider":"shell","model":5}');
    expect(createBrowserChatSettingsStore().read()).toEqual({ provider: 'claude-code', model: '' });
    window.localStorage.setItem('atlas.chat', 'not json');
    expect(createBrowserChatSettingsStore().read()).toEqual({ provider: 'claude-code', model: '' });
  });

  it('keeps the choice for this session where storage refuses it', () => {
    const store = createBrowserChatSettingsStore();
    const refuse = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    store.write({ provider: 'anthropic-api', model: '' });
    expect(store.read().provider).toBe('anthropic-api');
    refuse.mockRestore();
  });
});
