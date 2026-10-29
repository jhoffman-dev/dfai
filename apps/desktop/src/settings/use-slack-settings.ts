import { useCallback, useEffect, useRef, useState } from 'react';
import { explainSlackFailure, SLACK_SCOPES } from '@dfai/domain';
import {
  checkSlack,
  connectSlack,
  SlackError,
  type SlackIdentity,
  type SlackPort,
} from '@dfai/application';
import type { SlackTokenState, SlackView } from '@dfai/ui';
import { errorMessage } from '../query/error-message.ts';

/** Settings → Slack as the card draws it, and what it can ask for. */
export interface SlackSettingState {
  readonly view: SlackView;
  /** Hands the token to the host, which keeps it; it is held nowhere here. */
  readonly connect: (token: string) => void;
  readonly disconnect: () => void;
}

/** What is known of the vault's token: its state, and who Slack says it reads as. */
interface Known {
  readonly vault: string;
  readonly tokenState: SlackTokenState;
  readonly identity: SlackIdentity | null;
  readonly problem: string | null;
}

/** A failure in the card's words: Slack's problem and its fix, or what went wrong. */
const wordsOf = (cause: unknown) => {
  if (!(cause instanceof SlackError)) return errorMessage(cause);
  const { problem, fix } = explainSlackFailure(cause.failure, 'settings');
  return `${problem} ${fix}`;
};

/** What a check of a kept token found: accepted, refused, or not known (Slack was not reached). */
function checked(vault: string, cause: unknown): Known {
  const refused = cause instanceof SlackError && cause.failure.kind === 'refused';
  return {
    vault,
    tokenState: refused ? 'refused' : 'set',
    identity: null,
    problem: wordsOf(cause),
  };
}

/**
 * Settings → Slack: whether the vault has a token on this Mac and whom Slack
 * says it reads as. Asked only while the card is drawn, so a window that
 * never opens Settings never asks the host or Slack. The token passes
 * through `connect` to the host and is never kept in React state.
 */
export function useSlackSettings({
  port,
  vault,
}: {
  port: SlackPort;
  vault: string | null;
}): SlackSettingState {
  const [known, setKnown] = useState<Known | null>(null);
  const [pending, setPending] = useState(false);
  const changing = useRef(false);

  useEffect(() => {
    if (vault === null) return;
    let current = true;
    const know = (next: Known) => {
      if (current) setKnown(next);
    };
    port
      .status({ vault })
      .then(({ hasToken }) => {
        if (!hasToken) return know({ vault, tokenState: 'none', identity: null, problem: null });
        return checkSlack({ slack: port, vault }).then(
          (identity) => know({ vault, tokenState: 'connected', identity, problem: null }),
          (cause: unknown) => know(checked(vault, cause)),
        );
      })
      .catch((cause: unknown) =>
        know({ vault, tokenState: 'none', identity: null, problem: wordsOf(cause) }),
      );
    return () => {
      current = false;
    };
  }, [port, vault]);

  const change = useCallback((ask: () => Promise<Known>) => {
    // One change of token at a time: the host does not order a disconnect after a connect under way.
    if (changing.current) return;
    changing.current = true;
    setPending(true);
    ask()
      .then(setKnown)
      .finally(() => {
        changing.current = false;
        setPending(false);
      });
  }, []);

  const mine = known !== null && known.vault === vault ? known : null;
  return {
    view: {
      tokenState: mine?.tokenState ?? 'checking',
      workspace: mine?.identity?.workspace ?? null,
      user: mine?.identity?.user ?? null,
      scopes: SLACK_SCOPES,
      problem: mine?.problem ?? null,
      pending,
    },
    connect: (token) => {
      if (vault === null) return;
      change(() =>
        connectSlack({ slack: port, vault, token }).then(
          (identity): Known => ({ vault, tokenState: 'connected', identity, problem: null }),
          async (cause: unknown): Promise<Known> => {
            const { hasToken } = await port.status({ vault }).catch(() => ({ hasToken: false }));
            return hasToken
              ? checked(vault, cause)
              : { vault, tokenState: 'none', identity: null, problem: wordsOf(cause) };
          },
        ),
      );
    },
    disconnect: () => {
      if (vault === null) return;
      change(() =>
        port.disconnect({ vault }).then(
          (): Known => ({ vault, tokenState: 'none', identity: null, problem: null }),
          (cause: unknown): Known => ({
            ...(mine ?? checked(vault, cause)),
            problem: wordsOf(cause),
          }),
        ),
      );
    },
  };
}
