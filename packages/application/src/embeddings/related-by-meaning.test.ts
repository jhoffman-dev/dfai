import { describe, expect, it } from 'vitest';
import { digestOf } from '@dfai/domain';
import { blockMarkdown } from '../testing/block-markdown.ts';
import { fakeEmbedder, memoryEmbeddingCache } from '../testing/fake-embeddings.ts';
import { createSemanticEngine, type SemanticOptIn } from './semantic-engine.ts';

const VAULT = '/vault';

const NOTES = {
  'Meetings/Standup.md': 'Mara Quill moves payday to Friday.',
  'Payroll/Wages.md': 'Wages are paid on the last day of the month.',
  'Home/Garden.md': 'Tobias Fenn keeps bees behind the shed.',
  'Home/Honey.md': 'The hive gave honey in June.',
  'Archive/Old salary.md': 'The salary was paid weekly.',
  'Elsewhere/Wages.md': 'Wages, salary and payroll, all paid.',
};

function setUp(notes: Record<string, string> = NOTES, { on = true } = {}) {
  const files = new Map(Object.entries(notes));
  const embedder = fakeEmbedder();
  const turnedOn = new Set<string>(on ? [VAULT] : []);
  const optIn: SemanticOptIn = {
    isOn: (vault) => turnedOn.has(vault),
    turnOn: (vault) => turnedOn.add(vault),
  };
  const engine = createSemanticEngine({
    vault: VAULT,
    fs: {
      readNotes: async (paths) =>
        paths.flatMap((path) => {
          const text = files.get(path);
          return text === undefined ? [] : [{ path, text, modified: 1, size: text.length }];
        }),
    },
    markdown: blockMarkdown(),
    index: {
      manifest: async () =>
        [...files].map(([path, text]) => ({
          path,
          digest: digestOf(text),
          type: null,
          modified: 1,
          size: text.length,
        })),
    },
    embedder,
    cache: memoryEmbeddingCache({ vault: VAULT }),
    idle: { idle: async () => {} },
    optIn,
  });
  return { engine, embedder, turnedOn };
}

const nothingExcluded = { linked: new Set<string>(), dismissed: new Set<string>() };

describe('related notes by meaning', () => {
  it('offers the notes closest in meaning, best first, never the note itself', async () => {
    const { engine } = setUp();
    await engine.start();
    await engine.settled();
    const answer = await engine.related({ path: 'Meetings/Standup.md', exclude: nothingExcluded });
    expect(answer.embedded).toBe(true);
    const paths = answer.notes.map((note) => note.path);
    expect(paths.slice(0, 2).sort()).toEqual(['Elsewhere/Wages.md', 'Payroll/Wages.md']);
    expect(paths).not.toContain('Meetings/Standup.md');
    expect(answer.notes[0]!.score).toBeGreaterThan(answer.notes.at(-1)!.score);
  });

  it('leaves out the Archive, and every note linked or dismissed', async () => {
    const { engine } = setUp();
    await engine.start();
    await engine.settled();
    const answer = await engine.related({
      path: 'Meetings/Standup.md',
      exclude: { linked: new Set(['Payroll/Wages.md']), dismissed: new Set(['Home/Honey.md']) },
      limit: 50,
    });
    const paths = answer.notes.map((note) => note.path);
    expect(paths).toContain('Elsewhere/Wages.md');
    expect(paths).not.toContain('Payroll/Wages.md');
    expect(paths).not.toContain('Home/Honey.md');
    expect(paths).not.toContain('Archive/Old salary.md');
  });

  it('links each by its path where its name is shared, and by its title', async () => {
    const { engine } = setUp();
    await engine.start();
    await engine.settled();
    const { notes } = await engine.related({ path: 'Home/Garden.md', exclude: nothingExcluded });
    expect(notes[0]).toMatchObject({ path: 'Home/Honey.md', title: 'Honey', target: 'Honey' });
    const wages = notes.filter((note) => note.title === 'Wages').map((note) => note.target);
    expect(wages.length).toBeGreaterThan(0);
    expect(wages.some((target) => target.includes('/'))).toBe(true);
  });

  it('asks the model nothing: the vectors are the cache’s', async () => {
    const { engine, embedder } = setUp();
    await engine.start();
    await engine.settled();
    const before = embedder.calls.length;
    await engine.related({ path: 'Meetings/Standup.md', exclude: nothingExcluded });
    expect(embedder.calls).toHaveLength(before);
  });

  it('says a note not in the cache yet is not embedded, and offers nothing', async () => {
    const { engine } = setUp();
    await engine.start();
    await engine.settled();
    const answer = await engine.related({ path: 'New.md', exclude: nothingExcluded });
    expect(answer).toMatchObject({ notes: [], embedded: false });
  });

  it('never turns search by meaning on, nor builds anything, where it is off', async () => {
    const { engine, embedder, turnedOn } = setUp(NOTES, { on: false });
    const answer = await engine.related({ path: 'Meetings/Standup.md', exclude: nothingExcluded });
    expect(answer).toMatchObject({ notes: [], embedded: false });
    expect(turnedOn.size).toBe(0);
    await engine.settled();
    expect(embedder.calls).toHaveLength(0);
  });

  it('opens the cache by itself where it is on but not yet started', async () => {
    const { engine } = setUp();
    const first = await engine.related({ path: 'Meetings/Standup.md', exclude: nothingExcluded });
    expect(first.embedded).toBe(false);
    await engine.settled();
    const later = await engine.related({ path: 'Meetings/Standup.md', exclude: nothingExcluded });
    expect(later.embedded).toBe(true);
    expect(later.notes.length).toBeGreaterThan(0);
  });
});
