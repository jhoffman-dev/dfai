import { describe, expect, it } from 'vitest';
import type { ModelProvider } from '@dfai/application';
import { DEFAULT_CHAT_MODEL } from '@dfai/domain';
import type { ChatSettings, ChatSettingsStore } from './chat-settings-store.ts';
import { claudeStepPorts } from './claude-step-ports.ts';
import type { ChatPorts } from './use-chat.ts';

/**
 * A rule's Claude step reaches Claude the way the chat does (P29-03): the
 * provider and model Settings → Claude chose, read as each run starts — so a
 * change in Settings reaches the next run without a restart.
 */

const provider = (id: ModelProvider['id']): ModelProvider => ({
  id,
  status: async () => ({ ready: true }),
  stream: async function* () {},
});

function setUp(start: ChatSettings) {
  let settings = start;
  const store: ChatSettingsStore = { read: () => settings, write: (next) => (settings = next) };
  const vaults: (string | null)[] = [];
  const ports: ChatPorts = {
    claudeCode: provider('claude-code'),
    anthropicApi: (vault) => {
      vaults.push(vault());
      return provider('anthropic-api');
    },
  };
  const step = claudeStepPorts({
    ports,
    store,
    toolboxes: { reading: () => ({ specs: [], run: async () => ({}) as never }) },
    vault: () => '/vaults/home',
    selfName: () => 'Mara Quill',
    selfEmails: () => [],
  });
  return { step, store, vaults };
}

describe('claudeStepPorts', () => {
  it('uses the provider and model chosen when each run starts', () => {
    const { step, store, vaults } = setUp({ provider: 'claude-code', model: '' });
    expect(step.provider().id).toBe('claude-code');
    expect(step.model()).toBe(DEFAULT_CHAT_MODEL);

    store.write({ provider: 'anthropic-api', model: 'claude-test-model' });
    expect(step.provider().id).toBe('anthropic-api');
    expect(vaults).toEqual(['/vaults/home']);
    expect(step.model()).toBe('claude-test-model');
  });

  it('gives each run a time limit that has not yet passed', () => {
    const { step } = setUp({ provider: 'claude-code', model: '' });
    expect(step.deadline(60_000).aborted).toBe(false);
    expect(step.clock.today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
