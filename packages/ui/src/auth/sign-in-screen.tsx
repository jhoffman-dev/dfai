import type { AuthFailureKind } from '@dfai/domain';

/** What the screen says for each reason a sign-in failed or a session ended (#663). */
export const SIGN_IN_MESSAGES: Readonly<Record<AuthFailureKind, string>> = {
  denied:
    'You cancelled on GitHub. DFAI needs access to your vault repository to open it — and to nothing else.',
  'state-mismatch':
    'That sign-in did not start in this tab, so DFAI ignored it. Sign in again from here.',
  stale: 'That sign-in took too long and expired. Sign in again.',
  'bad-code': 'GitHub did not accept that sign-in; it may have been used already. Sign in again.',
  revoked:
    'GitHub no longer lets DFAI reach your vault: the app was removed from the repository, or its access was revoked or ran out. Sign in again to reconnect it.',
  'no-session': 'Your sign-in has ended. Sign in again to open your vault.',
  network:
    'DFAI could not reach its sign-in service. Check your connection and try again. If you were signing out, sign out again once you are online, or this browser may sign you back in.',
  refused: 'Signing in did not work. Try again.',
  malformed: 'Signing in did not work. Try again.',
};

export interface SignInScreenProps {
  readonly checking: boolean;
  readonly reason: AuthFailureKind | null;
  readonly onSignIn: () => void;
}

/** The web build's front door (#663): sign in with GitHub, or why the last try did not work. */
export function SignInScreen({ checking, reason, onSignIn }: SignInScreenProps) {
  return (
    <main className="sign-in" aria-labelledby="sign-in-title">
      <div className="sign-in__card">
        <h1 id="sign-in-title" className="sign-in__title">
          DFAI
        </h1>
        {checking ? (
          <p className="sign-in__text" role="status">
            Checking your sign-in…
          </p>
        ) : (
          <>
            <p className="sign-in__text">
              Sign in with GitHub to open your vault. DFAI asks for your vault repository alone, and
              no server keeps your notes.
            </p>
            {reason !== null && (
              <p className="sign-in__problem" role="alert">
                {SIGN_IN_MESSAGES[reason]}
              </p>
            )}
            <button type="button" className="btn btn--primary" onClick={onSignIn}>
              Sign in with GitHub
            </button>
          </>
        )}
      </div>
    </main>
  );
}

/** Sign out, floating at the window's corner while the web build is signed in (#663). */
export function SignOutButton({ onSignOut }: { readonly onSignOut: () => void }) {
  return (
    <button type="button" className="btn btn--secondary btn--sm sign-out" onClick={onSignOut}>
      Sign out
    </button>
  );
}
