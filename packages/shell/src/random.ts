import type { Rng } from '@dfai/application';

/**
 * The chance a new block id is drawn from: the platform's cryptographic
 * source, which every webview has, so two ids drawn in one millisecond, or in
 * two windows, still differ.
 */
export const cryptoRng: Rng = {
  next: () => {
    const [word] = crypto.getRandomValues(new Uint32Array(1));
    return (word ?? 0) / 2 ** 32;
  },
};
