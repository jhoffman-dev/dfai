import type { AuthPort, AuthState } from '@dfai/application';
import { SignInScreen, SignOutButton } from '@dfai/ui';
import { createRoot, type Root } from 'react-dom/client';

/** Where GitHub sends the person back to (the function's CALLBACK_PATH). */
export const CALLBACK_PATH = '/auth/callback';

export interface StartWebDeps {
  readonly auth: AuthPort;
  /** Mounts the app in #root and returns its teardown (mountShell). */
  readonly mountApp: () => () => void;
  readonly page?: Window;
}

/**
 * The web build's start (#663): the sign-in screen until the session is
 * there, then the app, and the screen again if the session ends — signed
 * out here, or its access revoked on GitHub. Which one shows is the
 * session's to say; this only draws it.
 */
export async function startWeb({ auth, mountApp, page = window }: StartWebDeps) {
  const view = webView({ auth, mountApp, page });
  const stop = auth.subscribe(() => view.show(auth.state()));
  view.show(auth.state());
  await auth.restore(callbackQuery(page));
  return () => {
    stop();
    view.close();
  };
}

/**
 * GitHub's callback query, taken off the address bar and out of history
 * before it is redeemed, so the code is never left behind. Any other page's
 * query is no callback, whatever it holds.
 */
function callbackQuery(page: Window): string {
  if (page.location.pathname !== CALLBACK_PATH) return '';
  const query = page.location.search;
  page.history.replaceState(null, '', '/');
  return query;
}

function webView({ auth, mountApp, page }: Required<StartWebDeps>) {
  const element = page.document.getElementById('root');
  if (!element) throw new Error('index.html is missing #root');
  const reported = (error: unknown) => page.reportError(error);
  let screen: Root | null = null;
  let app: (() => void) | null = null;
  let removeSignOut: (() => void) | null = null;

  const signedIn = () => {
    screen?.unmount();
    screen = null;
    app ??= mountApp();
    removeSignOut ??= showSignOut(page, () => auth.signOut().catch(reported));
  };

  const signedOut = (state: Exclude<AuthState, { status: 'signed-in' }>) => {
    app?.();
    app = null;
    removeSignOut?.();
    removeSignOut = null;
    screen ??= createRoot(element);
    screen.render(
      <SignInScreen
        checking={state.status === 'checking'}
        reason={state.status === 'signed-out' ? state.reason : null}
        onSignIn={() => auth.signIn().catch(reported)}
      />,
    );
  };

  return {
    show: (state: AuthState) => (state.status === 'signed-in' ? signedIn() : signedOut(state)),
    close: () => {
      signedOut({ status: 'checking' });
      screen?.unmount();
      screen = null;
    },
  };
}

/** The sign-out button in a root of its own beside the app's; returns its removal. */
function showSignOut(page: Window, onSignOut: () => void): () => void {
  const host = page.document.createElement('div');
  page.document.body.append(host);
  const root = createRoot(host);
  root.render(<SignOutButton onSignOut={onSignOut} />);
  return () => {
    root.unmount();
    host.remove();
  };
}
