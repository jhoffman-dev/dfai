import { useState, type ReactNode } from 'react';
import { noteTitle, type ActivityLevel, type VaultPath } from '@dfai/domain';
import type { Clock } from '@dfai/application';
import { EventDetailsButton } from '@dfai/ui';
import { noticeDetails } from './activity/event-details.ts';
import { browserClipboard, type ClipboardWriter } from './settings/clipboard.ts';
import { localClock } from './today.ts';
import type { LinkOffer } from './vault/use-vault-entries.ts';

/**
 * What the window has to tell the person, above whatever is open: plain
 * messages, the offer to update links a move left behind, and kept work that
 * could not be saved. A message, and the word of kept work, opens to its
 * details (#815): an error and a warning, as Activity keeps them.
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
  const words = (message: string, level: ActivityLevel) => (
    <EventDetailsButton
      details={noticeDetails({ message, level, at: since(message) }, clock.today())}
      className="notice__details"
      onCopy={(text) => clipboard.write(text)}
    >
      {message}
    </EventDetailsButton>
  );
  return (
    <>
      {messages.map(
        (message, at) =>
          message !== null && (
            <p key={at} className="notice" role="alert">
              {words(message, 'error')}
            </p>
          ),
      )}
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
          words={words(stranded.notice, 'warning')}
        />
      )}
      {keptComments !== undefined && keptComments.notice !== null && (
        <KeptWork
          kept={keptComments}
          discard="Discard kept comments on"
          words={words(keptComments.notice, 'warning')}
        />
      )}
    </>
  );
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
