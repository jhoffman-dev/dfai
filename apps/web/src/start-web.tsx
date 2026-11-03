import { opensApp, waitsForNetwork, type AuthPort, type AuthState } from '@dfai/application';
import { SignInScreen, SignOutButton } from '@dfai/ui';
import { createRoot, type Root } from 'react-dom/client';

/** Where GitHub sends the person back to (the function's CALLBACK_PATH). */
export const CALLBACK_PATH = '/auth/callback';

export interface StartWebDeps {
  readonly auth: AuthPort;
  /**
   * Mounts the app in #root and returns its teardown (mountShell). Told
   * whether this tab signed in just now, through GitHub's callback, rather
   * than restoring the session it had (#667).
   */
  readonly mountApp: (how: { freshSignIn: boolean }) => () => void;
  /** What the sign-out button does: the session's sign-out, and forgetting what the device kept (#667). */
  readonly signOut?: () => Promise<void>;
  /** Whether this device keeps a vault, which then opens when only the network keeps the session away (#667). */
  readonly vaultOnDevice?: () => boolean;
  readonly page?: Window;
}

/**
 * The web build's start (#663): the sign-in screen until the session is
 * there, then the app, and the screen again if the session ends — signed
 * out here, or its access revoked on GitHub. Which one shows is the
 * session's to say; this only draws it.
 */
export async function startWeb({
  auth,
  mountApp,
  signOut = () => auth.signOut(),
  vaultOnDevice = () => false,
  page = window,
}: StartWebDeps) {
  const query = callbackQuery(page);
  const view = webView({
    auth,
    mountApp: () => mountApp({ freshSignIn: query !== '' }),
    signOut,
    vaultOnDevice,
    page,
  });
  const stop = auth.subscribe(() => view.show(auth.state()));
  // Back online, a session the network alone kept away is tried again: the app opened offline signs in under it.
  const retry = () => {
    if (waitsForNetwork(auth.state())) auth.restore('').catch((error) => page.reportError(error));
  };
  page.addEventListener('online', retry);
  view.show(auth.state());
  await auth.restore(query);
  return () => {
    stop();
    page.removeEventListener('online', retry);
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

function webView({
  auth,
  mountApp,
  signOut,
  vaultOnDevice,
  page,
}: Required<Omit<StartWebDeps, 'mountApp'>> & { mountApp: () => () => void }) {
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
    // Shown again once the sign-out settles: what the device kept is gone by then, so offline is the sign-in.
    removeSignOut ??= showSignOut(page, () =>
      signOut()
        .catch(reported)
        .finally(() => show(auth.state())),
    );
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

  const show = (state: AuthState) => {
    if (state.status === 'signed-in' || opensApp(state, { vaultOnDevice: vaultOnDevice() }))
      signedIn();
    else signedOut(state);
  };

  return {
    show,
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
