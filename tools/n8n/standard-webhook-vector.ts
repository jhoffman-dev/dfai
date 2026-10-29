/*
 * The test vector in the Standard Webhooks spec and its reference libraries
 * (github.com/standard-webhooks/standard-webhooks): a delivery and the
 * signature its secret gives. Shared by the tests of the check and of the
 * Code node that runs it.
 */
export const VECTOR = {
  secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
  id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
  timestamp: '1614265330',
  body: '{"test": 2432232314}',
  signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
} as const;

/** The vector's moment, in milliseconds: the clock its timestamp is fresh on. */
export const VECTOR_NOW = Number(VECTOR.timestamp) * 1000;

/** The headers n8n's Webhook node hands over for a delivery (names lower-case). */
export const vectorHeaders = (overrides: Record<string, string> = {}) => ({
  'webhook-id': VECTOR.id,
  'webhook-timestamp': VECTOR.timestamp,
  'webhook-signature': VECTOR.signature,
  ...overrides,
});
