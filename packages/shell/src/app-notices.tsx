import { noteTitle, type VaultPath } from '@dfai/domain';
import type { LinkOffer } from './vault/use-vault-entries.ts';

/**
 * What the window has to tell the person, above whatever is open: plain
 * messages, the offer to update links a move left behind, and kept work that
 * could not be saved.
 */
export function AppNotices({
  messages,
  links,
  stranded,
  keptComments,
}: {
  /** Each message shown on its own; a null is nothing to say. */
  messages: readonly (string | null)[];
  links: LinkOffer | null;
  stranded: KeptWorkNotice;
  /** Comments a closed literature note could not write (#534): said with their words, and let go of by hand. */
  keptComments?: KeptWorkNotice;
}) {
  return (
    <>
      {messages.map(
        (message, at) =>
          message !== null && (
            <p key={at} className="notice" role="alert">
              {message}
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
      {stranded.notice !== null && <KeptWork kept={stranded} discard="Discard kept changes to" />}
      {keptComments !== undefined && keptComments.notice !== null && (
        <KeptWork kept={keptComments} discard="Discard kept comments on" />
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
function KeptWork({ kept, discard }: { kept: KeptWorkNotice; discard: string }) {
  return (
    <div className="notice">
      <p role="alert">{kept.notice}</p>
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
