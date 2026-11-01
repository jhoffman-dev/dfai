// The web build's sign-in with GitHub, through its function (#663, ADR-0052).
export {
  AUTH_API,
  functionAuthGateway,
  REFRESH_LOCK,
  REVOKED_RETRY_MS,
} from './function-auth-gateway.ts';
export type { CrossTabLock, FunctionAuthGatewayDeps } from './function-auth-gateway.ts';
export {
  AUTH_CHANNEL,
  broadcastChannelAuth,
  PENDING_KEY,
  sessionStoragePendingSignIn,
  webCryptoRandom,
  webCryptoSha256,
  webLocks,
} from './browser-auth-stores.ts';
export { HOLD_MS, POLL_MS, SETTLE_MS, storageLock } from './storage-lock.ts';
export type { StorageLockDeps } from './storage-lock.ts';
