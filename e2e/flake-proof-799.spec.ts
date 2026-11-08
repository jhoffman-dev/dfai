import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from './fixtures.ts';

// THROWAWAY (#799 proof): fails the first time it runs on a machine, passes after.
test('flake proof 799 fails its first try on a machine', () => {
  // The run's own temp folder, which its workers share and its end removes.
  const marker = join(tmpdir(), 'flake-proof-799.marker');
  let first = true;
  try {
    writeFileSync(marker, '', { flag: 'wx' });
  } catch {
    first = false;
  }
  expect(first, 'the first try on this machine fails on purpose').toBe(false);
});
