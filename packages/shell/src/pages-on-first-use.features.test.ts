import { describe, expect, it, vi } from 'vitest';
import { EVERY_FEATURE_ON, featuresOn } from '@dfai/domain';

/*
 * A feature switched off loads none of its code (#901): Reading's chunks — the
 * readers, and the Library with All highlights — are fetched only by
 * `preloadFeatures`, and only while Reading is on. The chunks stand in for
 * the real ones, which carry pdf.js and foliate-js, and say when they are fetched.
 */
const fetched = vi.hoisted(() => [] as string[]);

vi.mock('./reader/readers.ts', () => {
  fetched.push('readers');
  return { DocumentReader: () => null, BookReaderTab: () => null };
});
vi.mock('./research/research-screens.tsx', () => {
  fetched.push('research-screens');
  return { LibraryScreen: () => null, HighlightsScreen: () => null };
});

const { featurePreloads, preloadFeatures } = await import('./pages-on-first-use.ts');

describe('preloadFeatures', () => {
  it("knows Reading's parts", () => {
    expect(featurePreloads('reading').length).toBeGreaterThan(0);
  });

  it('fetches nothing of Reading while it is off', async () => {
    await preloadFeatures(featuresOn(['reading']));
    expect(fetched).toEqual([]);
  });

  it("fetches Reading's chunks once it is on", async () => {
    await preloadFeatures(EVERY_FEATURE_ON);
    expect([...fetched].sort()).toEqual(['readers', 'research-screens']);
  });
});
