import {
  createWikiLinkResolver,
  foldedLinkName,
  linkKeysOf,
  wikiLinkSpans,
  type WikiLink,
} from '../links/index.ts';
import { buildTagTree, isTagWithin, noteTags, type TagCount, type TagSort } from '../tags/index.ts';
import type { TagTreeNode } from '../tags/index.ts';
import { isVisibleNote, noteTitle, type VaultPath } from '../vault/index.ts';
import { noteSummary } from './summary.ts';

/** A note as the index reads it. */
export interface IndexedNote {
  readonly path: VaultPath;
  readonly text: string;
}

/** A link out of a note, and the note it opens — null when none does yet. */
export interface OutgoingLink extends WikiLink {
  readonly resolved: VaultPath | null;
}

/** A link target no note answers to, and the notes that link to it. */
export interface UnresolvedTarget {
  /** Folded, as links compare targets: the ghost node's identity. */
  readonly key: string;
  /** As the first linking note (by path) writes it. */
  readonly target: string;
  readonly sources: readonly VaultPath[];
}

export interface GraphNode {
  /** A note's path, or `ghost:<key>` for a link target no note answers to. */
  readonly id: string;
  readonly kind: 'note' | 'ghost';
  readonly title: string;
}

export interface GraphEdge {
  readonly source: string;
  readonly target: string;
}

export interface VaultGraph {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

interface Entry {
  readonly links: readonly WikiLink[];
  readonly linkKeys: ReadonlySet<string>;
  readonly tags: readonly { key: string; name: string }[];
  readonly summary: string;
}

const byCode = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/**
 * What the vault's notes say about each other, derived from their text and
 * nothing else: links out, backlinks, unresolved targets, tags and the graph.
 * It changes one note at a time (`upsert`, `remove`, `rename`), so a keystroke
 * re-reads one note, not the vault. Every list it returns is sorted, so the
 * same notes always give the same answers in the same order.
 *
 * Only visible notes are indexed (`isVisibleNote`): a path under `_index/` or
 * `.dfai-lite/`, a dotfile, or a file that is not markdown is ignored.
 */
export class VaultIndex {
  private readonly entries = new Map<VaultPath, Entry>();
  /** Which notes link to each folded target. */
  private readonly linkers = new Map<string, Set<VaultPath>>();
  /** Which notes use each tag key. */
  private readonly tagged = new Map<string, Set<VaultPath>>();
  private sorted: VaultPath[] | null = null;
  private resolver: ((target: string) => VaultPath | null) | null = null;

  static build(notes: Iterable<IndexedNote>): VaultIndex {
    const index = new VaultIndex();
    for (const { path, text } of notes) index.upsert(path, text);
    return index;
  }

  /** Reads (or re-reads) one note. False when the path is not one the index holds. */
  upsert(path: VaultPath, text: string): boolean {
    if (!isVisibleNote(path)) return false;
    const isNew = !this.entries.has(path);
    this.forget(path);
    const links = wikiLinkSpans(text)
      .map(({ link }) => ({ target: link.target, heading: link.heading, alias: link.alias }))
      .filter((link) => link.target.trim() !== '');
    const entry: Entry = {
      links,
      linkKeys: new Set(links.map((link) => foldedLinkName(link.target))),
      tags: noteTags(text),
      summary: noteSummary(text),
    };
    this.entries.set(path, entry);
    for (const key of entry.linkKeys) addTo(this.linkers, key, path);
    for (const { key } of entry.tags) addTo(this.tagged, key, path);
    if (isNew) this.pathsChanged();
    return true;
  }

  remove(path: VaultPath): void {
    if (!this.entries.has(path)) return;
    this.forget(path);
    this.entries.delete(path);
    this.pathsChanged();
  }

  /** Moves a note's entry to `to`; its text, and so what it links and tags, is unchanged. */
  rename(from: VaultPath, to: VaultPath): void {
    const entry = this.entries.get(from);
    if (entry === undefined) return;
    this.remove(from);
    if (!isVisibleNote(to)) return;
    this.entries.set(to, entry);
    for (const key of entry.linkKeys) addTo(this.linkers, key, to);
    for (const { key } of entry.tags) addTo(this.tagged, key, to);
    this.pathsChanged();
  }

  has(path: VaultPath): boolean {
    return this.entries.has(path);
  }

  /** Every indexed note's path, sorted. */
  paths(): readonly VaultPath[] {
    this.sorted ??= [...this.entries.keys()].sort(byCode);
    return this.sorted;
  }

  /** The note a link target opens among the indexed notes (Obsidian's rules), or null. */
  resolve(target: string): VaultPath | null {
    this.resolver ??= createWikiLinkResolver(this.paths());
    return this.resolver(target);
  }

  /** A note's first sentence. Empty for a note with none, or one not indexed. */
  summary(path: VaultPath): string {
    return this.entries.get(path)?.summary ?? '';
  }

  /** A note's links in the order written, each with the note it opens. A `[[#Heading]]` is left out. */
  outgoing(path: VaultPath): readonly OutgoingLink[] {
    const entry = this.entries.get(path);
    if (entry === undefined) return [];
    return entry.links.map((link) => ({ ...link, resolved: this.resolve(link.target) }));
  }

  /** The other notes with a link that opens `path`, sorted. */
  backlinks(path: VaultPath): readonly VaultPath[] {
    return this.linkSources(linkKeysOf(path)).filter(
      (source) =>
        source !== path &&
        this.entries.get(source)?.links.some((link) => this.resolve(link.target) === path),
    );
  }

  /**
   * The notes with a link whose folded target is one of `keys` (`linkKeysOf`,
   * `foldedLinkName`), sorted: the few a rename may need to rewrite.
   */
  linkSources(keys: Iterable<string>): readonly VaultPath[] {
    const sources = new Set<VaultPath>();
    for (const key of keys) for (const source of this.linkers.get(key) ?? []) sources.add(source);
    return [...sources].sort(byCode);
  }

  /** Every link target no note answers to, by key. */
  unresolved(): readonly UnresolvedTarget[] {
    const found = new Map<string, { target: string; sources: VaultPath[] }>();
    for (const source of this.paths()) {
      for (const link of (this.entries.get(source) as Entry).links) {
        if (this.resolve(link.target) !== null) continue;
        const key = foldedLinkName(link.target);
        const known = found.get(key);
        if (known === undefined) found.set(key, { target: link.target.trim(), sources: [source] });
        else if (known.sources.at(-1) !== source) known.sources.push(source);
      }
    }
    return [...found]
      .sort(([left], [right]) => byCode(left, right))
      .map(([key, { target, sources }]) => ({ key, target, sources }));
  }

  /** A note's tags, each once, spelled as first written, in the order they appear. */
  tagsOf(path: VaultPath): readonly { key: string; name: string }[] {
    return this.entries.get(path)?.tags ?? [];
  }

  /** The notes tagged `key` — and, unless `nested` is false, any tag under it — sorted. */
  notesWithTag(key: string, { nested = true }: { nested?: boolean } = {}): readonly VaultPath[] {
    const found = new Set<VaultPath>();
    for (const [tag, paths] of this.tagged) {
      if (tag === key || (nested && isTagWithin(tag, key)))
        for (const path of paths) found.add(path);
    }
    return [...found].sort(byCode);
  }

  /**
   * Every tag in use with the number of notes using it, by key. A tag is
   * shown as the first note by path spells it, whoever wrote it last.
   */
  tagCounts(): readonly TagCount[] {
    return [...this.tagged]
      .sort(([left], [right]) => byCode(left, right))
      .map(([key, paths]) => {
        const first = [...paths].sort(byCode)[0] as VaultPath;
        const name = this.tagsOf(first).find((tag) => tag.key === key)?.name ?? key;
        return { key, name, count: paths.size };
      });
  }

  tagTree(sort: TagSort = 'name'): TagTreeNode[] {
    return buildTagTree(this.tagCounts(), sort);
  }

  /**
   * The vault as a graph: a node per note, a ghost node per target nothing
   * answers to, and one edge per linking pair (a note's links to itself left out).
   */
  graph(): VaultGraph {
    const nodes: GraphNode[] = this.paths().map((path) => ({
      id: path,
      kind: 'note',
      title: noteTitle(path),
    }));
    const ghosts = new Map<string, string>();
    const edges = new Map<string, GraphEdge>();
    for (const source of this.paths()) {
      for (const link of (this.entries.get(source) as Entry).links) {
        const resolved = this.resolve(link.target);
        if (resolved === source) continue;
        let target = resolved;
        if (target === null) {
          const key = foldedLinkName(link.target);
          target = `ghost:${key}`;
          if (!ghosts.has(target)) ghosts.set(target, link.target.trim());
        }
        edges.set(`${source}\n${target}`, { source, target });
      }
    }
    for (const [id, title] of [...ghosts].sort(([left], [right]) => byCode(left, right))) {
      nodes.push({ id, kind: 'ghost', title });
    }
    const sortedEdges = [...edges]
      .sort(([left], [right]) => byCode(left, right))
      .map(([, edge]) => edge);
    return { nodes, edges: sortedEdges };
  }

  private forget(path: VaultPath): void {
    const entry = this.entries.get(path);
    if (entry === undefined) return;
    for (const key of entry.linkKeys) removeFrom(this.linkers, key, path);
    for (const { key } of entry.tags) removeFrom(this.tagged, key, path);
  }

  private pathsChanged(): void {
    this.sorted = null;
    this.resolver = null;
  }
}

function addTo(map: Map<string, Set<VaultPath>>, key: string, path: VaultPath): void {
  const set = map.get(key);
  if (set === undefined) map.set(key, new Set([path]));
  else set.add(path);
}

function removeFrom(map: Map<string, Set<VaultPath>>, key: string, path: VaultPath): void {
  const set = map.get(key);
  if (set === undefined) return;
  set.delete(path);
  if (set.size === 0) map.delete(key);
}
