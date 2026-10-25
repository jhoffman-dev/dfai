/**
 * A 64-bit digest of a passage, as 16 hex characters: what says a block is
 * unchanged, so it is never embedded twice (ADR-0031).
 *
 * `digestOf` (32 bits) is enough to tell one version of a file from the next,
 * but a vault of 50,000 blocks would hold two blocks of the same 32-bit
 * digest about one time in three. Two independent 32-bit lanes (cyrb53's
 * mixing, kept to 64 bits) make that about one in seven billion.
 */
export function passageDigest(text: string): string {
  let high = 0xdeadbeef;
  let low = 0x41c6ce57;
  for (let at = 0; at < text.length; at += 1) {
    const code = text.charCodeAt(at);
    high = Math.imul(high ^ code, 2654435761);
    low = Math.imul(low ^ code, 1597334677);
  }
  high = Math.imul(high ^ (high >>> 16), 2246822507) ^ Math.imul(low ^ (low >>> 13), 3266489909);
  low = Math.imul(low ^ (low >>> 16), 2246822507) ^ Math.imul(high ^ (high >>> 13), 3266489909);
  return hex(high) + hex(low);
}

const hex = (lane: number): string => (lane >>> 0).toString(16).padStart(8, '0');
