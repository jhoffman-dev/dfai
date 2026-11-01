export { createAuthService } from './auth-service.ts';
export { AuthError } from './ports.ts';
export type {
  AuthGateway,
  AuthPort,
  AuthState,
  PendingSignInStore,
  SecureRandom,
  Sha256,
} from './ports.ts';
export { redeemGrant, restoreSession, startSignIn } from './sign-in.ts';
export type { AuthDeps, SessionOutcome } from './sign-in.ts';
