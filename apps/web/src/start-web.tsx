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

/** The parameters a sign-in callback carries. */
const CALLBACK_PARAMS = ['code', 'state', 'error', 'error_description', 'error_uri'];

/**
 * GitHub's callback query, taken off the address bar and out of history
 * before it is redeemed, so the code is never left behind. On any other
 * page the same parameters are taken off too but redeem nothing: only the
 * callback's query is a callback.
 */
function callbackQuery(page: Window): string {
  const { pathname, search, hash } = page.location;
  if (pathname === CALLBACK_PATH) {
    page.history.replaceState(null, '', '/');
    return search;
  }
  const params = new URLSearchParams(search);
  if (!CALLBACK_PARAMS.some((name) => params.has(name))) return '';
  for (const name of CALLBACK_PARAMS) params.delete(name);
  const rest = params.toString();
  page.history.replaceState(null, '', `${pathname}${rest ? `?${rest}` : ''}${hash}`);
  return '';
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
