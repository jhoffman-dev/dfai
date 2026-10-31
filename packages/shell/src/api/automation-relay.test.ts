import { describe, expect, it } from 'vitest';
import { createAutomationRelay } from './automation-relay.ts';

const PAUSED = new Map([['tidy', { reason: 'Paused.', retryAt: null }]]);

describe('createAutomationRelay', () => {
  it("answers the runner's state for the vault it was last told of", () => {
    const relay = createAutomationRelay();

    relay.point({ vault: '/v/One', watchingSince: '2026-09-22T08:00:00', pauses: new Map() });
    relay.point({ vault: '/v/Two', watchingSince: '2026-09-22T09:00:00', pauses: PAUSED });

    expect(relay.clock.forVault('/v/Two')).toEqual({
      watchingSince: '2026-09-22T09:00:00',
      pauses: PAUSED,
    });
  });

  it('knows nothing of another vault, nor of any before it is told', () => {
    const relay = createAutomationRelay();
    expect(relay.clock.forVault('/v/One')).toBeNull();

    relay.point({ vault: '/v/One', watchingSince: '2026-09-22T08:00:00', pauses: PAUSED });

    expect(relay.clock.forVault('/v/Two')).toBeNull();
  });

  it('knows nothing while the runner has not started watching', () => {
    const relay = createAutomationRelay();

    relay.point({ vault: '/v/One', watchingSince: null, pauses: new Map() });

    expect(relay.clock.forVault('/v/One')).toBeNull();
  });
});
