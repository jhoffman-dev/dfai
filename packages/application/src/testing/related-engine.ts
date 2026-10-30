import { digestOf } from '@dfai/domain';
import { blockMarkdown } from './block-markdown.ts';
import { fakeEmbedder, memoryEmbeddingCache } from './fake-embeddings.ts';
import { createSemanticEngine, type SemanticOptIn } from '../embeddings/semantic-engine.ts';

/**
 * A semantic engine over notes on a pretend disk, with the fake model and an
 * in-memory cache, for related notes. `idle.hold()` keeps the build waiting
 * for an idle moment, so work it has queued — a note's forget — is not done
 * yet, as in a long build.
 */
export function relatedEngine(
  notes: Record<string, string>,
  { vault = '/vault', on = true }: { vault?: string; on?: boolean } = {},
) {
  const files = new Map(Object.entries(notes));
  const embedder = fakeEmbedder();
  const turnedOn = new Set<string>(on ? [vault] : []);
  const optIn: SemanticOptIn = {
    isOn: (named) => turnedOn.has(named),
    turnOn: (named) => turnedOn.add(named),
  };
  let held = false;
  const idle = {
    hold: () => {
      held = true;
    },
    idle: () => (held ? new Promise<void>(() => {}) : Promise.resolve()),
  };
  const engine = createSemanticEngine({
    vault,
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
    cache: memoryEmbeddingCache({ vault }),
    idle,
    optIn,
  });
  /** A note deleted on disk, as the index's sync tells the engine. */
  const remove = (path: string) => {
    files.delete(path);
    engine.hear({ vault, changes: [{ kind: 'removed', path, type: null, digest: '' }] });
  };
  /** A note written on disk, as the index's sync tells the engine. */
  const change = (path: string, text: string) => {
    files.set(path, text);
    engine.hear({
      vault,
      changes: [{ kind: 'changed', path, type: null, digest: digestOf(text) }],
    });
  };
  /**
   * A long build: a note's embed waits for an idle moment that does not come,
   * and every forget heard after it waits behind it.
   */
  const busy = (path: string) => {
    idle.hold();
    change(path, `${files.get(path) ?? ''}\n\nMore words.`);
  };
  return { engine, embedder, turnedOn, files, idle, remove, busy };
}
