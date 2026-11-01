import { sessionFreshness, type AuthFailureKind, type AuthSession } from '@dfai/domain';
import { AuthError, type AuthPort, type AuthState } from './ports.ts';
import { redeemGrant, restoreSession, startSignIn, type AuthDeps } from './sign-in.ts';

/**
 * The web build's sign-in (#663, ADR-0052): the session in memory, never
 * stored, and the refresh before it expires.
 *
 * Three rules keep a refresh token, which GitHub rotates on every use, from
 * being spent twice or outliving a sign-out: refreshes run one at a time
 * (callers share the one in flight), none starts once a sign-out has begun,
 * and an answer that lands after the session ended is dropped. A sign-out
 * is told to the browser's other tabs, which end theirs too.
 */
export function createAuthService(deps: AuthDeps): AuthPort {
  return new AuthService(deps);
}

class AuthService implements AuthPort {
  private current: AuthState = { status: 'checking' };
  private session: AuthSession | null = null;
  /** Counts the sessions ended, so an answer for an ended one is known for stale. */
  private generation = 0;
  private signingOut = false;
  /** A token granted to a restore or refresh that landed during a sign-out: the one to revoke. */
  private lateToken: string | null = null;
  private refreshing: Promise<AuthSession> | null = null;
  private restoring: Promise<unknown> | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: AuthDeps) {
    deps.broadcast?.onSignOut(() => {
      if (this.current.status !== 'signed-out') this.end(null);
    });
  }

  state = (): AuthState => this.current;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  restore = (query: string): Promise<AuthState> => {
    const run = this.restoreNow(query);
    this.restoring = run;
    return run.finally(() => {
      if (this.restoring === run) this.restoring = null;
    });
  };

  signIn = (): Promise<void> => startSignIn(this.deps);

  /**
   * Refuses any new refresh, ends the session here and tells the other tabs
   * at once, then waits out a restore or refresh in flight (so its token is
   * the one revoked) and asks the function to forget this browser — under
   * the refresh lock, so another tab's refresh cannot land after it. When
   * the function cannot be reached, the cookie may outlive this page: the
   * screen says so.
   */
  signOut = async (): Promise<void> => {
    this.signingOut = true;
    this.lateToken = null;
    try {
      const accessToken = this.session?.accessToken ?? null;
      this.end(null);
      this.deps.broadcast?.announceSignOut();
      // Their outcome no longer matters, only that they have landed: the session has ended.
      await Promise.all(
        [this.restoring, this.refreshing].map((call) => call?.catch(() => undefined)),
      );
      await this.forget(this.lateToken ?? accessToken);
    } finally {
      this.signingOut = false;
      this.lateToken = null;
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

  /**
   * One refresh first, since a 401 may only mean this clock ran slow and the
   * token expired early; a refused refresh ends the session as any does,
   * and one that cannot be reached ends it too, the token being no good.
   */
  rejected = async (accessToken: string): Promise<void> => {
    if (this.session?.accessToken !== accessToken) return;
    try {
      await this.refreshOnce();
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
      if (this.session?.accessToken === accessToken) this.end(error.kind);
    }
  };

  private async restoreNow(query: string): Promise<AuthState> {
    const generation = this.generation;
    const outcome = await restoreSession(this.deps, query);
    // A sign-out waiting on this restore revokes what it granted, without a moment signed in.
    if (this.signingOut && 'session' in outcome) this.lateToken = outcome.session.accessToken;
    if (generation !== this.generation || this.signingOut) return this.current;
    if ('session' in outcome) this.begin(outcome.session);
    else this.end(outcome.failure);
    return this.current;
  }

  private async forget(accessToken: string | null): Promise<void> {
    try {
      await this.deps.gateway.signOut({ accessToken });
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
      this.end('network');
    }
  }

  private refreshOnce(): Promise<AuthSession> {
    if (this.signingOut) return Promise.reject(new AuthError('no-session', 'signing out'));
    this.refreshing ??= this.refreshNow().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /** A failed refresh ends the session, unless only the network failed: the token may still work. */
  private async refreshNow(): Promise<AuthSession> {
    const generation = this.generation;
    const outcome = await redeemGrant(this.deps, () => this.deps.gateway.refresh());
    if (this.signingOut && 'session' in outcome) this.lateToken = outcome.session.accessToken;
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
