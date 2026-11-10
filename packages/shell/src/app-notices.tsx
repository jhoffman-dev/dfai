import { useRef, useState, type ReactNode } from 'react';
import { noteTitle, type ActivityLevel, type VaultPath } from '@dfai/domain';
import type { Clock } from '@dfai/application';
import { EventDetailsButton, EventDetailsHost } from '@dfai/ui';
import { noticeDetails } from './activity/event-details.ts';
import { browserClipboard, type ClipboardWriter } from './settings/clipboard.ts';
import { localClock } from './today.ts';
import type { LinkOffer } from './vault/use-vault-entries.ts';

/**
 * What the window has to tell the person, above whatever is open: plain
 * messages, the offer to update links a move left behind, and kept work that
 * could not be saved. A message, and the word of kept work, opens to its
 * details (#815): an error and a warning, in the notice's own words. The
 * details stay open, on the words they opened with, when the notice clears
 * itself or another takes its place: they are held here, above the notices.
 * Closed with their notice gone, they hand the focus to the notices' region,
 * which is drawn — empty — while there is nothing to say.
 */
export function AppNotices({
  messages,
  links,
  stranded,
  keptComments,
  clock = localClock,
  clipboard = browserClipboard,
}: {
  /** Each message shown on its own; a null is nothing to say. */
  messages: readonly (string | null)[];
  links: LinkOffer | null;
  stranded: KeptWorkNotice;
  /** Comments a closed literature note could not write (#534): said with their words, and let go of by hand. */
  keptComments?: KeptWorkNotice;
  /** Dates a notice by when it was first shown. */
  clock?: Pick<Clock, 'now' | 'today'>;
  /** Where a notice's details are copied to. */
  clipboard?: ClipboardWriter;
}) {
  const since = useShownSince([...messages, stranded.notice, keptComments?.notice ?? null], clock);
  const region = useRef<HTMLDivElement>(null);
  // `id` tells this notice from another saying the same words: the focus goes back to the one pressed.
  const words = ({ id, message, level }: { id: string; message: string; level: ActivityLevel }) => (
    <EventDetailsButton
      // Dated as it is pressed: a notice left up past midnight is yesterday's.
      details={() => noticeDetails({ message, level, at: since(message) }, clock.today())}
      id={id}
      className="notice__details"
      onCopy={(text) => clipboard.write(text)}
    >
      {message}
    </EventDetailsButton>
  );
  return (
    <EventDetailsHost landmark={() => region.current}>
      <div ref={region} className="notices" role="region" aria-label="Notices" tabIndex={-1}>
        {keyedByWords(messages).map(({ key, message }) => (
          <p key={key} className="notice" role="alert">
            {words({ id: key, message, level: 'error' })}
          </p>
        ))}
        {links !== null && (
          <div className="notice">
            <p role="alert">{links.text}</p>
            <button className="viewer__resolve" type="button" onClick={links.update}>
              {links.action}
            </button>
            <button className="viewer__resolve" type="button" onClick={links.dismiss}>
              Leave them
            </button>
          </div>
        )}
        {/* Drawn only with something to say: an empty notice is no render on every app render. */}
        {stranded.notice !== null && (
          <KeptWork
            kept={stranded}
            discard="Discard kept changes to"
            words={words({
              id: `kept-work:${stranded.notice}`,
              message: stranded.notice,
              level: 'warning',
            })}
          />
        )}
        {keptComments !== undefined && keptComments.notice !== null && (
          <KeptWork
            kept={keptComments}
            discard="Discard kept comments on"
            words={words({
              id: `kept-comments:${keptComments.notice}`,
              message: keptComments.notice,
              level: 'warning',
            })}
          />
        )}
      </div>
    </EventDetailsHost>
  );
}

/**
 * The messages there are to show, each keyed by its words — and by a count
 * where two say the same — never by its place: another message in the same
 * place is another notice, with its own button and its own details.
 */
function keyedByWords(messages: readonly (string | null)[]): { key: string; message: string }[] {
  const said = new Map<string, number>();
  return messages.flatMap((message) => {
    if (message === null) return [];
    const before = said.get(message) ?? 0;
    said.set(message, before + 1);
    return [{ key: `${before}:${message}`, message }];
  });
}

interface KeptWorkNotice {
  readonly notice: string | null;
  readonly waiting: readonly VaultPath[];
  readonly forget: (path: VaultPath) => void;
}

/** Kept work that could not be saved, and a way to let go of each note's. */
function KeptWork({
  kept,
  discard,
  words,
}: {
  kept: KeptWorkNotice;
  discard: string;
  /** The notice's words, as the button that opens its details. */
  words: ReactNode;
}) {
  return (
    <div className="notice">
      <p role="alert">{words}</p>
      {/* Kept work for a note that has since been deleted can never be
          reopened, so it can also be let go of by hand. */}
      {kept.waiting.map((path) => (
        <button
          key={path}
          className="viewer__resolve"
          type="button"
          onClick={() => kept.forget(path)}
        >
          {discard} {noteTitle(path)}
        </button>
      ))}
    </div>
  );
}

/**
 * When each notice on screen was first shown, by its words: a notice that
 * stays keeps its time, and one that goes and comes back is dated again, as
 * Activity records it again.
 */
function useShownSince(
  notices: readonly (string | null)[],
  clock: Pick<Clock, 'now'>,
): (notice: string) => number {
  const [since, setSince] = useState<ReadonlyMap<string, number>>(new Map());
  const shown = new Set(notices.filter((notice) => notice !== null));
  const same = shown.size === since.size && [...shown].every((notice) => since.has(notice));
  if (same) return (notice) => since.get(notice) ?? clock.now();
  // The notices changed: the times are brought in step as this draw is made, not after it.
  const now = new Map([...shown].map((notice) => [notice, since.get(notice) ?? clock.now()]));
  setSince(now);
  return (notice) => now.get(notice) ?? clock.now();
}
