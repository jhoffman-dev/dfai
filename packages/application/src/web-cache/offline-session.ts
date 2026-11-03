import type { AuthState } from '../auth/ports.ts';

/**
 * Whether the web build shows the app rather than its sign-in (#667):
 * signed in, or kept from signing in only by the network while this device
 * keeps a vault, whose kept notes then open with no network. Any other
 * reason to be signed out — signed out here, refused or revoked on GitHub —
 * shows the sign-in.
 */
export function opensApp(state: AuthState, { vaultOnDevice }: { vaultOnDevice: boolean }): boolean {
  if (state.status === 'signed-in') return true;
  return state.status === 'signed-out' && state.reason === 'network' && vaultOnDevice;
}

/** Whether the session is held up by the network alone, so it is tried again once back online. */
export const waitsForNetwork = (state: AuthState): boolean =>
  state.status === 'signed-out' && state.reason === 'network';
