// The web build's sign-in with GitHub, through its function (#663, ADR-0052).
export { AUTH_API, functionAuthGateway, REFRESH_LOCK } from './function-auth-gateway.ts';
export type { CrossTabLock, FunctionAuthGatewayDeps } from './function-auth-gateway.ts';
export {
  PENDING_KEY,
  sessionStoragePendingSignIn,
  webCryptoRandom,
  webCryptoSha256,
  webLocks,
} from './browser-auth-stores.ts';
