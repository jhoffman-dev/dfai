import { describe, expect, it } from 'vitest';
import { artifactPlacement } from './artifact.ts';

describe('artifactPlacement for a title that already fits (#672 attack)', () => {
  // Before #672 a line break cleaned to a space, so a two-line title kept both
  // lines; the first-line rule meant for pasted captures now drops the second.
  it('names a two-line title as it did before the phone layout', () => {
    expect(artifactPlacement({ title: 'Q3 plan\nDraft for Sam', taken: new Set() }).notePath).toBe(
      'artifacts/Q3 plan Draft for Sam.md',
    );
  });
});
