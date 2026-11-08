import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from './fixtures.ts';

// THROWAWAY (PR #802 proof): fails the first time it runs in a run, passes after.
test('flake proof 802 fails its first try in a run', () => {
  // The run's own temp folder, which its workers share and its end removes.
  const marker = join(tmpdir(), 'flake-proof-802.marker');
  let first = true;
  try {
    writeFileSync(marker, '', { flag: 'wx' });
  } catch {
    first = false;
  }
  expect(first, 'the first try in this run fails on purpose').toBe(false);
});

// THROWAWAY (PR #802 proof): quarantined and macOS-only, naming throwaway issue #807.
test(
  'quarantine proof 802 runs only on macOS',
  {
    tag: ['@mac', '@quarantine'],
    annotation: [
      { type: 'macOS only', description: 'proof' },
      { type: 'quarantine', description: '#807' },
    ],
  },
  () => {
    expect(process.platform).toBe('darwin');
  },
);
