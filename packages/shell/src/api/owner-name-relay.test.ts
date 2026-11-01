import { describe, expect, it } from 'vitest';
import { createOwnerNameRelay } from './owner-name-relay.ts';

describe('createOwnerNameRelay', () => {
  it('knows no name until the app points it at one, then the latest', () => {
    const relay = createOwnerNameRelay();
    expect(relay.name()).toBeNull();
    relay.point('Mara Quill');
    expect(relay.name()).toBe('Mara Quill');
    relay.point(null);
    expect(relay.name()).toBeNull();
  });
});
