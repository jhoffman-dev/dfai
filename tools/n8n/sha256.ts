/*
 * SHA-256 and HMAC-SHA256 (FIPS 180-4, RFC 2104) in plain JavaScript, for
 * the Granola webhook's signature check. Compiled into an n8n Code node, it
 * needs neither `require('crypto')` nor the Crypto node, whichever of them
 * n8n Cloud's sandbox allows (ADR-0034's spike), nor Buffer or TextEncoder.
 */

const ROUND_CONSTANTS = Uint32Array.of(
  0x428a2f98,
  0x71374491,
  0xb5c0fbcf,
  0xe9b5dba5,
  0x3956c25b,
  0x59f111f1,
  0x923f82a4,
  0xab1c5ed5,
  0xd807aa98,
  0x12835b01,
  0x243185be,
  0x550c7dc3,
  0x72be5d74,
  0x80deb1fe,
  0x9bdc06a7,
  0xc19bf174,
  0xe49b69c1,
  0xefbe4786,
  0x0fc19dc6,
  0x240ca1cc,
  0x2de92c6f,
  0x4a7484aa,
  0x5cb0a9dc,
  0x76f988da,
  0x983e5152,
  0xa831c66d,
  0xb00327c8,
  0xbf597fc7,
  0xc6e00bf3,
  0xd5a79147,
  0x06ca6351,
  0x14292967,
  0x27b70a85,
  0x2e1b2138,
  0x4d2c6dfc,
  0x53380d13,
  0x650a7354,
  0x766a0abb,
  0x81c2c92e,
  0x92722c85,
  0xa2bfe8a1,
  0xa81a664b,
  0xc24b8b70,
  0xc76c51a3,
  0xd192e819,
  0xd6990624,
  0xf40e3585,
  0x106aa070,
  0x19a4c116,
  0x1e376c08,
  0x2748774c,
  0x34b0bcb5,
  0x391c0cb3,
  0x4ed8aa4a,
  0x5b9cca4f,
  0x682e6ff3,
  0x748f82ee,
  0x78a5636f,
  0x84c87814,
  0x8cc70208,
  0x90befffa,
  0xa4506ceb,
  0xbef9a3f7,
  0xc67178f2,
);

const INITIAL_HASH = Uint32Array.of(
  0x6a09e667,
  0xbb67ae85,
  0x3c6ef372,
  0xa54ff53a,
  0x510e527f,
  0x9b05688c,
  0x1f83d9ab,
  0x5be0cd19,
);

/** An element of a fixed-length array; every index used here is in range. */
const at = (words: Uint32Array | Uint8Array, index: number): number => words[index] ?? 0;

const rotateRight = (word: number, by: number) => (word >>> by) | (word << (32 - by));

/** The message, padded to whole 64-byte blocks and ending in its length in bits. */
function padded(message: Uint8Array): DataView {
  const blocks = Math.ceil((message.length + 9) / 64);
  const bytes = new Uint8Array(blocks * 64);
  bytes.set(message);
  bytes[message.length] = 0x80;
  const view = new DataView(bytes.buffer);
  const bits = message.length * 8;
  view.setUint32(bytes.length - 8, Math.floor(bits / 2 ** 32));
  view.setUint32(bytes.length - 4, bits >>> 0);
  return view;
}

/** The message schedule for the block at `offset`. */
function schedule(view: DataView, offset: number, words: Uint32Array): void {
  for (let i = 0; i < 16; i += 1) words[i] = view.getUint32(offset + i * 4);
  for (let i = 16; i < 64; i += 1) {
    const early = at(words, i - 15);
    const late = at(words, i - 2);
    const sigma0 = rotateRight(early, 7) ^ rotateRight(early, 18) ^ (early >>> 3);
    const sigma1 = rotateRight(late, 17) ^ rotateRight(late, 19) ^ (late >>> 10);
    words[i] = (at(words, i - 16) + sigma0 + at(words, i - 7) + sigma1) >>> 0;
  }
}

type EightWords = [number, number, number, number, number, number, number, number];

/** One block folded into `hash`: the 64 rounds over the eight working words. */
function compress(hash: Uint32Array, words: Uint32Array): void {
  // The hash is always eight words.
  let [a, b, c, d, e, f, g, h] = Array.from(hash) as EightWords;
  for (let i = 0; i < 64; i += 1) {
    const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
    const choice = (e & f) ^ (~e & g);
    const first = (h + sum1 + choice + at(ROUND_CONSTANTS, i) + at(words, i)) >>> 0;
    const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
    const second = (sum0 + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
    [h, g, f, e, d, c, b, a] = [g, f, e, (d + first) >>> 0, c, b, a, (first + second) >>> 0];
  }
  [a, b, c, d, e, f, g, h].forEach((word, n) => {
    hash[n] = at(hash, n) + word;
  });
}

export function sha256(message: Uint8Array): Uint8Array {
  const view = padded(message);
  const hash = Uint32Array.from(INITIAL_HASH);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < view.byteLength; offset += 64) {
    schedule(view, offset, words);
    compress(hash, words);
  }
  const digest = new DataView(new ArrayBuffer(32));
  hash.forEach((word, n) => digest.setUint32(n * 4, word));
  return new Uint8Array(digest.buffer);
}

const BLOCK = 64;

/** HMAC-SHA256 of `message` under `key` (RFC 2104). */
export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  const block = new Uint8Array(BLOCK);
  block.set(key.length > BLOCK ? sha256(key) : key);
  const inner = new Uint8Array(BLOCK + message.length);
  const outer = new Uint8Array(BLOCK + 32);
  for (let i = 0; i < BLOCK; i += 1) {
    inner[i] = at(block, i) ^ 0x36;
    outer[i] = at(block, i) ^ 0x5c;
  }
  inner.set(message, BLOCK);
  outer.set(sha256(inner), BLOCK);
  return sha256(outer);
}
