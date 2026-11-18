import { describe, expect, it, vi } from 'vitest';
import { EVERY_FEATURE_ON, featuresOn } from '@dfai/domain';

/*
 * A feature switched off loads none of its code (#901): Reading's chunks — the
 * readers, and the Library with All highlights — and the Graph's page are
 * fetched only by `preloadFeatures`, and only while their feature is on. Ask
 * is in the chunk most parts share, which `preloadPages` fetches for them
 * anyway; it is listed under Ask so a page of its own would follow the switch.
 * The chunks stand in for the real ones and say when they are fetched.
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

vi.mock('./graph/graph-page.tsx', () => {
  fetched.push('graph-page');
  return { default: () => null };
});
vi.mock('./later-parts.ts', () => {
  fetched.push('later-parts');
  return { AskScreen: () => null };
});

const { featurePreloads, preloadFeatures } = await import('./pages-on-first-use.ts');

describe('preloadFeatures', () => {
  it("knows Reading's, the Graph's and Ask's parts", () => {
    expect(featurePreloads('reading').length).toBeGreaterThan(0);
    expect(featurePreloads('graph').length).toBe(1);
    expect(featurePreloads('ask').length).toBe(1);
  });

  it('fetches nothing of Reading, the Graph or Ask while they are off', async () => {
    await preloadFeatures(featuresOn(['reading', 'graph', 'ask']));
    expect(fetched).toEqual([]);
  });

  it('fetches the Graph alone when only it is on of the three', async () => {
    await preloadFeatures(featuresOn(['reading', 'ask']));
    expect(fetched).toEqual(['graph-page']);
  });

  it("fetches every feature's chunks once it is on", async () => {
    await preloadFeatures(EVERY_FEATURE_ON);
    expect([...fetched].sort()).toEqual([
      'graph-page',
      'later-parts',
      'readers',
      'research-screens',
    ]);
  });
});
