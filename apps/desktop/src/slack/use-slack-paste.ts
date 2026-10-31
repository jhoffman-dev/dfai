import { useCallback, useEffect, useRef, useState } from 'react';
import { readSlackPermalink, type CaptureKind, type VaultPath } from '@dfai/domain';
import {
  readSlackMessage,
  saveSlackMessage,
  type CapturePorts,
  type SlackMessagePreview,
  type SlackPort,
} from '@dfai/application';
import type { SlackOfferView } from '@dfai/ui';
import { problemOf } from './slack-offer-state.ts';

/** The offer a pasted Slack link makes, and what it can be asked to do. */
export interface SlackPaste {
  /** Null when nothing has been pasted, or the offer was dismissed. */
  readonly view: SlackOfferView | null;
  /** Offers to save the message `text` links to; false, and nothing done, when it is not a Slack message link. */
  readonly offer: (text: string) => boolean;
  readonly save: (kind: CaptureKind) => void;
  readonly open: () => void;
  readonly dismiss: () => void;
}

export interface SlackPastePorts {
  readonly slack: SlackPort;
  readonly capture: CapturePorts;
  /** The open vault's path, which each Slack call names; null with none open. */
  readonly vault: string | null;
  readonly timeZone: () => string;
  readonly openNote: (path: VaultPath) => void;
}

/** What the offer holds besides its view: the vault it was pasted in, the message read, and its save. */
interface Held {
  readonly vault: string | null;
  readonly preview: SlackMessagePreview | null;
  /** A save is under way or done: the message is saved once from one offer. */
  readonly saving: boolean;
  readonly saved: VaultPath | null;
}

/** The offer drawn, and the vault it was made in. */
interface Offered {
  readonly vault: string | null;
  readonly view: SlackOfferView;
}

const NOTHING_HELD: Held = { vault: null, preview: null, saving: false, saved: null };

/**
 * A pasted Slack message link, read through the host and offered for saving
 * as an Inbox note or task (#105). Each paste replaces the offer before it,
 * and an answer to an earlier paste is dropped; an offer made in one vault
 * is not shown, or saved, in another. The link itself is the editor's or the
 * field's: nothing here takes it out of what was pasted.
 */
export function useSlackPaste(ports: SlackPastePorts): SlackPaste {
  const [offered, setOffered] = useState<Offered | null>(null);
  const held = useRef<Held>(NOTHING_HELD);
  /** Shows `view` as the offer made in the vault the paste was in. */
  const setView = useCallback((view: SlackOfferView | null) => {
    setOffered(view === null ? null : { vault: held.current.vault, view });
  }, []);
  const latest = useRef(0);
  const portsNow = useRef(ports);
  useEffect(() => {
    portsNow.current = ports;
  });

  /** Runs `step` for the current paste only: a later paste or a dismiss drops its answer. */
  const forThisPaste = useCallback(() => {
    const paste = latest.current;
    return (apply: () => void) => {
      if (latest.current === paste) apply();
    };
  }, []);

  const offer = useCallback(
    (text: string) => {
      const link = readSlackPermalink(text);
      const { slack, vault } = portsNow.current;
      if (link === null || vault === null) return false;
      latest.current += 1;
      held.current = { ...NOTHING_HELD, vault };
      setView({ state: 'reading' });
      const here = forThisPaste();
      readSlackMessage({ slack, vault, link, kind: 'task' }).then(
        (preview) =>
          here(() => {
            held.current = { ...held.current, preview };
            setView({ state: 'ready', ...previewView(preview), saving: false });
          }),
        (cause: unknown) => here(() => setView(problemOf(cause))),
      );
      return true;
    },
    [forThisPaste, setView],
  );

  const save = useCallback(
    (kind: CaptureKind) => {
      const { preview, saving, vault } = held.current;
      const { capture, timeZone } = portsNow.current;
      if (preview === null || saving || vault !== portsNow.current.vault) return;
      held.current = { ...held.current, saving: true };
      setView({ state: 'ready', ...previewView(preview), saving: true });
      const here = forThisPaste();
      saveSlackMessage({
        ports: capture,
        payload: preview.payload,
        kind,
        timeZone: timeZone(),
      }).then(
        (receipt) =>
          here(() => {
            held.current = { ...held.current, saved: receipt.path };
            setView({ state: 'saved', outcome: receipt.outcome, kind });
          }),
        (cause: unknown) => here(() => setView(problemOf(cause))),
      );
    },
    [forThisPaste, setView],
  );

  const dismiss = useCallback(() => {
    latest.current += 1;
    held.current = NOTHING_HELD;
    setView(null);
  }, [setView]);

  const open = useCallback(() => {
    const { saved } = held.current;
    if (saved !== null) portsNow.current.openNote(saved);
  }, []);

  const view = offered !== null && offered.vault === ports.vault ? offered.view : null;
  return { view, offer, save, open, dismiss };
}

const previewView = ({ author, text, replies, attachments }: SlackMessagePreview) => ({
  author,
  text,
  replies,
  attachments,
});
