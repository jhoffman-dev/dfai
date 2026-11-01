import { useCallback, useMemo, useRef } from 'react';
import {
  createWikiLinkResolver,
  newBlockId,
  type Transclusion,
  type VaultPath,
  type WikiLink,
} from '@dfai/domain';
import {
  anchorBlock,
  createBlockChoicesReader,
  createTransclusionReader,
  type IndexPort,
  type MarkdownPort,
  type OpenNotes,
  type Rng,
  type TransclusionReader,
  type VaultFsPort,
} from '@dfai/application';
import type { BlockChoices, BlockPicking, NoteTransclusions } from '@dfai/ui';
import { useVaultImages } from './use-images.ts';

interface ReadPorts {
  readonly fs: VaultFsPort;
  readonly markdown: MarkdownPort;
}

/** Where the note's shown blocks are, as the page has it now. */
interface Place {
  readonly notePath: VaultPath | null;
  readonly notePaths: readonly VaultPath[];
}

/** A shown block asked for, waiting for the read that answers every one asked for with it. */
interface Pending {
  readonly link: WikiLink;
  readonly settle: (shown: Promise<Transclusion>) => void;
}

/**
 * Where a note's shown blocks (P26-03) read the blocks they show: the notes
 * their links name, each read once for all its blocks and again only when
 * the index says it changed. Every block asks again whenever `revision` —
 * the index's count of changes — moves, so an edit to the source, saved in
 * another pane or another app, reaches the embed.
 */
export function useTransclusions({
  fs,
  markdown,
  index,
  notePath,
  notePaths,
  revision,
}: ReadPorts & Place & { index: IndexPort; revision: string }): NoteTransclusions {
  const loadImage = useVaultImages({ fs, resetKey: notePath });
  const reader = useMemo(
    () => createTransclusionReader({ fs, markdown, index }),
    // A new note starts its blocks afresh.
    [fs, markdown, index, notePath],
  );
  const place = useRef<Place>({ notePath, notePaths });
  place.current = { notePath, notePaths };
  const load = useBatchedRead(reader, place);
  return useMemo(() => ({ load, loadImage, revision }), [load, loadImage, revision]);
}

/** `load` for each block, answered in one read of every block asked for in the same turn. */
function useBatchedRead(
  reader: TransclusionReader,
  place: { readonly current: Place },
): (link: WikiLink) => Promise<Transclusion> {
  const pending = useRef<Pending[]>([]);
  const flush = useCallback(() => {
    const asked = pending.current;
    pending.current = [];
    const { notePath, notePaths } = place.current;
    const shown =
      notePath === null
        ? Promise.reject(new Error('Blocks are shown in a note.'))
        : reader.read({ links: asked.map(({ link }) => link), holder: notePath, notePaths });
    asked.forEach(({ settle }, at) =>
      settle(
        shown.then((read) => {
          const one = read[at];
          if (one === undefined) throw new Error('The block was not read.');
          return one;
        }),
      ),
    );
  }, [reader, place]);
  return useCallback(
    (link: WikiLink) =>
      new Promise<Transclusion>((resolve, reject) => {
        if (pending.current.length === 0) queueMicrotask(flush);
        pending.current.push({ link, settle: (shown) => shown.then(resolve, reject) });
      }),
    [flush],
  );
}

/**
 * The picker's side of linking a block (P26-02): the headings and blocks of
 * the note a link names — this note's own are the editor's, read live — and
 * giving a block of another note an id, written there, refused when that
 * note has unsaved typing in a pane.
 */
export function useBlockPicking({
  fs,
  markdown,
  index,
  notePath,
  notePaths,
  openNotes,
  rng,
  onChanged,
  onRefused,
}: ReadPorts &
  Place & {
    index: IndexPort;
    openNotes: OpenNotes;
    rng: Rng;
    /** Re-reads the tree and the index, after an id was written to another note. */
    onChanged: () => void;
    onRefused: (reason: string) => void;
  }): BlockPicking {
  // A note's blocks are read once for each version of it, not on every key (A26-01).
  const choices = useMemo(
    () => createBlockChoicesReader({ fs, markdown, index }),
    [fs, markdown, index],
  );
  return useMemo<BlockPicking>(() => {
    // Asked on every key typed after `#`: the vault's names are indexed once
    // per set of notes, when first asked, not searched a key at a time (#225).
    let resolve: ((target: string) => VaultPath | null) | null = null;
    return {
      choicesFor: async (target): Promise<BlockChoices | null> => {
        const path =
          target === '' ? notePath : (resolve ??= createWikiLinkResolver(notePaths))(target);
        if (path === null) return null;
        if (path === notePath) return { same: true, target };
        const entries = await choices.read(path);
        return entries === null ? null : { same: false, target, path, entries };
      },
      anchor: async (block) => {
        const id = await anchorBlock({ fs, markdown, openNotes, rng, ...block });
        onChanged();
        return id;
      },
      newId: (taken) => newBlockId(() => rng.next(), taken),
      onRefused,
    };
  }, [fs, markdown, choices, notePath, notePaths, openNotes, rng, onChanged, onRefused]);
}
