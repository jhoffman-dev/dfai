import { useState, type FormEvent } from 'react';
import { SettingsSection } from './settings-section.tsx';
import { SETTINGS_SECTIONS } from './settings-section-links.ts';

/**
 * What this Mac holds for the vault: being asked; no token; a token Slack
 * has not been asked about yet; one it accepted; one it refused.
 */
export type SlackTokenState = 'checking' | 'none' | 'set' | 'connected' | 'refused';

/** Settings → Slack as the card draws it. There is no token here to show. */
export interface SlackView {
  readonly tokenState: SlackTokenState;
  /** The workspace and user Slack says the token reads as, once it has said. */
  readonly workspace: string | null;
  readonly user: string | null;
  /** The user token scopes DFAI reads with, to make the token with. */
  readonly scopes: readonly string[];
  readonly problem: string | null;
  /** A token is being kept, checked or forgotten. */
  readonly pending: boolean;
}

function statusOf(view: SlackView): string {
  switch (view.tokenState) {
    case 'checking':
      return 'Checking…';
    case 'none':
      return 'Not connected on this Mac';
    case 'set':
      return 'Token kept';
    case 'refused':
      return 'Slack refused this token';
    case 'connected': {
      const who = [view.user, view.workspace].filter((each) => each !== null).join(' in ');
      return who === '' ? 'Connected' : `Connected as ${who}`;
    }
  }
}

/**
 * Settings → Slack: the user token DFAI reads a pasted Slack link with
 * (#105). The token is typed into a masked field and handed on; the field is
 * emptied as it goes, and nothing on this card ever holds a token to show.
 */
export function SlackSettings({
  view,
  onConnect,
  onDisconnect,
}: {
  view: SlackView;
  onConnect: (token: string) => void;
  onDisconnect: () => void;
}) {
  const hasToken = view.tokenState !== 'none' && view.tokenState !== 'checking';
  return (
    <SettingsSection section={SETTINGS_SECTIONS.slack}>
      <p className="settings__lede">
        Paste a Slack message link into a note or quick capture, and DFAI offers to save the message
        and its thread to the Inbox as a note or a task. The token stays in this Mac’s Keychain,
        goes only to slack.com, and is used only to read.
      </p>
      <div className="settings__row">
        <span className="settings__row-text">
          <span className="settings__row-label">User token</span>
          <span className="settings__status" data-testid="slack-token">
            {statusOf(view)}
          </span>
        </span>
      </div>
      {!hasToken && (
        <p className="settings__lede">
          Make a Slack app at api.slack.com/apps with these user token scopes:{' '}
          <code>{view.scopes.join(', ')}</code>. Install it to your workspace, then paste its User
          OAuth Token (it starts <code>xoxp-</code>) here.
        </p>
      )}
      <TokenForm hasToken={hasToken} pending={view.pending} onConnect={onConnect} />
      {view.problem !== null && (
        <p className="settings__problem" role="alert">
          {view.problem}
        </p>
      )}
      {hasToken && (
        <div className="settings__actions">
          <button
            className="btn btn--ghost"
            type="button"
            disabled={view.pending}
            onClick={onDisconnect}
          >
            Disconnect
          </button>
        </div>
      )}
    </SettingsSection>
  );
}

function TokenForm({
  hasToken,
  pending,
  onConnect,
}: {
  hasToken: boolean;
  pending: boolean;
  onConnect: (token: string) => void;
}) {
  const [token, setToken] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onConnect(token.trim());
    setToken('');
  };

  return (
    <form className="secrets__form" aria-label="Connect Slack" onSubmit={submit}>
      <input
        className="field secrets__field"
        type="password"
        aria-label="Slack user token"
        placeholder={hasToken ? 'Paste a new token to replace it' : 'xoxp-…'}
        autoComplete="off"
        spellCheck={false}
        value={token}
        onChange={(event) => setToken(event.target.value)}
      />
      <button className="btn btn--primary" type="submit" disabled={pending || token.trim() === ''}>
        Connect
      </button>
    </form>
  );
}
