import { sessionFreshness, type AuthFailureKind, type AuthSession } from '@dfai/domain';
import { AuthError, type AuthPort, type AuthState } from './ports.ts';
import { redeemGrant, restoreSession, startSignIn, type AuthDeps } from './sign-in.ts';

/**
 * The web build's sign-in (#663, ADR-0052): the session in memory, never
 * stored, and the refresh before it expires.
 *
 * Two rules keep a refresh token, which GitHub rotates on every use, from
 * being spent twice or outliving a sign-out: refreshes run one at a time
 * (callers share the one in flight), and an answer that lands after the
 * session ended, by sign-out or revocation, is dropped.
 */
export function createAuthService(deps: AuthDeps): AuthPort {
  return new AuthService(deps);
}

class AuthService implements AuthPort {
  private current: AuthState = { status: 'checking' };
  private session: AuthSession | null = null;
  /** Counts the sessions ended, so an answer for an ended one is known for stale. */
  private generation = 0;
  private refreshing: Promise<AuthSession> | null = null;
  private restoring: Promise<unknown> | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: AuthDeps) {}

  state = (): AuthState => this.current;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  restore = async (query: string): Promise<AuthState> => {
    const generation = this.generation;
    const restoring = restoreSession(this.deps, query);
    this.restoring = restoring;
    const outcome = await restoring.finally(() => {
      this.restoring = null;
    });
    if (generation !== this.generation) return this.current;
    if ('session' in outcome) this.begin(outcome.session);
    else this.end(outcome.failure);
    return this.current;
  };

  signIn = (): Promise<void> => startSignIn(this.deps);

  /**
   * Waits out a restore or refresh in flight, so its new token is the one
   * revoked and its cookie is the one cleared, then ends the session here before asking
   * the function to forget it. When the function cannot be reached, the
   * cookie may outlive this page: the screen says so.
   */
  signOut = async (): Promise<void> => {
    // Its outcome no longer matters, only that it has landed: the session ends either way.
    await Promise.all(
      [this.restoring, this.refreshing].map((call) => call?.catch(() => undefined)),
    );
    const accessToken = this.session?.accessToken ?? null;
    this.end(null);
    try {
      await this.deps.gateway.signOut({ accessToken });
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
      this.end('network');
    }
  };

  tokenForRequest = async (): Promise<string> => {
    const session = this.session;
    if (!session) throw new AuthError('no-session');
    const freshness = sessionFreshness(session, this.deps.clock.now());
    if (freshness === 'fresh') return session.accessToken;
    try {
      return (await this.refreshOnce()).accessToken;
    } catch (error) {
      const stillGood = freshness === 'refresh-due' && this.session === session;
      if (stillGood && error instanceof AuthError && error.kind === 'network')
        return session.accessToken;
      throw error;
    }
  };

  rejected = (accessToken: string): void => {
    if (this.session?.accessToken === accessToken) this.end('revoked');
  };

  private refreshOnce(): Promise<AuthSession> {
    this.refreshing ??= this.refreshNow().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /** A failed refresh ends the session, unless only the network failed: the token may still work. */
  private async refreshNow(): Promise<AuthSession> {
    const generation = this.generation;
    const outcome = await redeemGrant(this.deps, () => this.deps.gateway.refresh());
    if (generation !== this.generation) throw new AuthError('no-session', 'the session ended');
    if ('failure' in outcome) {
      const kind = outcome.failure ?? 'no-session';
      if (kind !== 'network') this.end(kind);
      throw new AuthError(kind);
    }
    this.session = outcome.session;
    return outcome.session;
  }

  private begin(session: AuthSession): void {
    this.session = session;
    this.set({ status: 'signed-in' });
  }

  private end(reason: AuthFailureKind | null): void {
    this.generation += 1;
    this.session = null;
    this.set({ status: 'signed-out', reason });
  }

  private set(next: AuthState): void {
    this.current = next;
    for (const listener of [...this.listeners]) listener();
  }
}
