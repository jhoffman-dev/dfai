import type { VaultPath } from '../../domain/vault/index.ts';
import {
  DEFAULT_SETTINGS,
  type Clock,
  type SearchEngine,
  type SearchHit,
  type Settings,
  type SettingsStore,
} from '../ports/index.ts';

/** A clock stopped at one moment, moved only by `set`. */
export class FixedClock implements Clock {
  private moment: Date;
  constructor(moment: Date = new Date(2026, 10, 21, 9, 0)) {
    this.moment = moment;
  }

  now(): Date {
    return new Date(this.moment);
  }

  set(moment: Date): void {
    this.moment = moment;
  }
}

/** Settings held in memory, copied in and out like the real store's JSON round-trip. */
export class MemorySettingsStore implements SettingsStore {
  private settings: Settings;

  constructor(settings: Settings = DEFAULT_SETTINGS) {
    this.settings = structuredClone(settings);
  }

  load(): Settings {
    return structuredClone(this.settings);
  }

  save(settings: Settings): void {
    this.settings = structuredClone(settings);
  }
}

/**
 * A `SearchEngine` that matches every word of the query as a substring,
 * case aside; title matches rank first, then by path. Enough for use-case
 * and UI tests; the app uses MiniSearch.
 */
export class SimpleSearchEngine implements SearchEngine {
  private readonly notes = new Map<VaultPath, string>();

  index(notes: readonly { readonly path: VaultPath; readonly text: string }[]): void {
    this.notes.clear();
    for (const { path, text } of notes) this.notes.set(path, text);
  }

  update(path: VaultPath, text: string): void {
    this.notes.set(path, text);
  }

  remove(path: VaultPath): void {
    this.notes.delete(path);
  }

  search(query: string, { limit = 20 }: { readonly limit?: number } = {}): SearchHit[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];
    const hits: (SearchHit & { inTitle: boolean })[] = [];
    for (const [path, text] of this.notes) {
      const title = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
      const haystack = `${title}\n${text}`.toLowerCase();
      if (!words.every((word) => haystack.includes(word))) continue;
      const at = text.toLowerCase().indexOf(words[0] as string);
      const snippet = at < 0 ? text.slice(0, 80) : text.slice(Math.max(0, at - 30), at + 50);
      const inTitle = words.some((word) => title.toLowerCase().includes(word));
      hits.push({ path, title, snippet: snippet.trim(), inTitle });
    }
    hits.sort((left, right) =>
      left.inTitle !== right.inTitle ? (left.inTitle ? -1 : 1) : left.path < right.path ? -1 : 1,
    );
    return hits.slice(0, limit).map(({ path, title, snippet }) => ({ path, title, snippet }));
  }
}
