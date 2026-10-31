import type { ClaudeStepPorts } from '@dfai/application';
import { describe, expect, it } from 'vitest';
import { createClaudeStepRelay } from './claude-step-relay.ts';

describe('createClaudeStepRelay', () => {
  it('has no ports until the app points it at them, then the latest', () => {
    const relay = createClaudeStepRelay();
    expect(relay.ports()).toBeNull();
    // Only identity is relayed: nothing of the ports is called.
    const first = { model: () => 'claude-test' } as unknown as ClaudeStepPorts;
    relay.point(first);
    expect(relay.ports()).toBe(first);
    relay.point(null);
    expect(relay.ports()).toBeNull();
  });
});
