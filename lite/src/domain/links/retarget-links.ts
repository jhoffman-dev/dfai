import {
  folderOf,
  joinPath,
  noteTitle,
  pathAfterMove,
  type PathMove,
  type VaultPath,
} from '../vault/index.ts';
import { createWikiLinkResolver } from './resolve.ts';
import { wikiLinkSpans } from './wikilink-spans.ts';

/** The vault's notes either side of a move, and where each moved note went. */
export interface NotesAcrossMove {
  readonly before: readonly VaultPath[];
  readonly after: readonly VaultPath[];
  /** Each note the move carried, from its old path to its new one. */
  readonly moved: ReadonlyMap<VaultPath, VaultPath>;
}

/** The notes before and after `move`: a folder's move carries every note under it. */
export function notesAfterMove(move: PathMove, notes: readonly VaultPath[]): NotesAcrossMove {
  const moved = new Map<VaultPath, VaultPath>();
  const after = notes.map((path) => {
    const to = pathAfterMove(path, move);
    if (to === null) return path;
    moved.set(path, to);
    return to;
  });
  return { before: notes, after, moved };
}

/**
 * Resolvers for one move, built once and shared by every note retargeted
 * across it: building one per note made a rename slow in a large vault.
 */
export interface MoveResolvers {
  readonly before: (target: string) => VaultPath | null;
  readonly after: (target: string) => VaultPath | null;
  readonly moved: ReadonlyMap<VaultPath, VaultPath>;
}

export function moveResolvers(across: NotesAcrossMove): MoveResolvers {
  return {
    before: createWikiLinkResolver(across.before),
    after: createWikiLinkResolver(across.after),
    moved: across.moved,
  };
}

/**
 * Re-points every link the move broke, so it opens what it opened before:
 * a rename changes the name a link finds a note by; a move changes a link
 * written as a path; and a moved note can take a bare name from another note
 * of the same name, whose links are then written as its path. Only a link's
 * target changes — its `!`, heading and alias stay byte for byte, as does
 * everything else. A link that still opens its note, or that opened nothing,
 * is left alone, as is a link in code.
 */
export function retargetLinks(
  text: string,
  resolvers: MoveResolvers,
): { text: string; count: number } {
  let count = 0;
  let cursor = 0;
  const pieces: string[] = [];
  for (const { targetStart, targetEnd, link } of wikiLinkSpans(text)) {
    const opened = resolvers.before(link.target);
    if (opened === null) continue;
    const to = resolvers.moved.get(opened) ?? opened;
    if (resolvers.after(link.target) === to) continue;
    count += 1;
    pieces.push(text.slice(cursor, targetStart), targetFor(link.target, to, resolvers));
    cursor = targetEnd;
  }
  if (count === 0) return { text, count };
  pieces.push(text.slice(cursor));
  return { text: pieces.join(''), count };
}

/**
 * The target that opens `to` after the move: its name when the link was a
 * name and the name alone finds it, else its path — without `.md`, unless
 * the link was written with one.
 */
function targetFor(written: string, to: VaultPath, resolvers: MoveResolvers): string {
  const extension = /\.md$/i.test(written.trim()) ? '.md' : '';
  const name = `${noteTitle(to)}${extension}`;
  if (!written.includes('/') && resolvers.after(name) === to) return name;
  return joinPath(folderOf(to), name);
}
