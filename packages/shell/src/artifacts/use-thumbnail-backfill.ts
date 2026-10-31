import { useCallback, useRef, useState } from 'react';
import {
  artifactsWithoutThumbnails,
  type IndexPort,
  type MarkdownPort,
  type ThumbnailQueue,
  type VaultFsPort,
} from '@dfai/application';

/** "Generate missing thumbnails", and how far it has got. */
export interface ThumbnailBackfill {
  /** How many are still to be made; 0 when none are under way. */
  readonly left: number;
  /** How the last run ended, for saying so beside the button; null before one. */
  readonly report: string | null;
  readonly run: () => void;
}

/**
 * Makes a thumbnail for every artifact with a copy and no cover, through the
 * shared queue — a few at a time, so the rest of the app carries on — and
 * counts them down.
 */
export function useThumbnailBackfill({
  thumbnails,
  index,
  fs,
  markdown,
}: {
  thumbnails: Pick<ThumbnailQueue, 'request'>;
  index: IndexPort;
  fs: VaultFsPort;
  markdown: MarkdownPort;
}): ThumbnailBackfill {
  const [left, setLeft] = useState(0);
  const [report, setReport] = useState<string | null>(null);
  // The button is only disabled once the count is known; a press before that,
  // while the vault is still searched, would start a second run on the same count.
  const running = useRef(false);

  const run = useCallback(() => {
    if (running.current) return;
    running.current = true;
    setReport(null);
    void artifactsWithoutThumbnails({ index, fs, markdown })
      .then(async (paths) => {
        setLeft(paths.length);
        const results = await Promise.all(
          paths.map((path) =>
            thumbnails.request({ path, asked: false }).finally(() => setLeft((n) => n - 1)),
          ),
        );
        const made = results.filter((result) => result?.kind === 'made').length;
        const failed = results.filter((result) => result === null).length;
        setReport(reportOf({ wanted: paths.length, made, failed }));
      })
      .catch((cause: unknown) => {
        setLeft(0);
        setReport(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        running.current = false;
      });
  }, [thumbnails, index, fs, markdown]);

  return { left, report, run };
}

function reportOf({
  wanted,
  made,
  failed,
}: {
  wanted: number;
  made: number;
  failed: number;
}): string {
  if (wanted === 0) return 'Every artifact with a copy has a thumbnail';
  const madeText = `Made ${made} ${made === 1 ? 'thumbnail' : 'thumbnails'}`;
  return failed === 0 ? madeText : `${madeText}; ${failed} could not be made`;
}
