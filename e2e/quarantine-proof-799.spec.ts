import { expect, test } from './fixtures.ts';
import { quarantined } from './quarantine.ts';

// THROWAWAY (#799 proof): one quarantined test naming an open issue, one a closed one.
test('quarantine proof 799 names an open issue', quarantined(799), () => {
  expect(1 + 1).toBe(2);
});

test('quarantine proof 799 names a closed issue', quarantined(785), () => {
  expect(1 + 1).toBe(2);
});
