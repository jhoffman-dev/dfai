import { writeFileSync } from 'node:fs';
import { test } from 'vitest';

// A synchronous loop: no per-test timeout can stop it, as in #737. The marker
// tells the test that started this run that the loop is about to begin.
test('never ends', () => {
  writeFileSync(process.env.STILL_RUNNING_MARKER!, 'looping');
  for (;;);
});
