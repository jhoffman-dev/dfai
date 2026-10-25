import type { SemanticOptIn } from '@dfai/application';

const PREFIX = 'atlas.semantic-search:';

/**
 * Whether semantic search has been used in a vault on this Mac, kept in the
 * app's own storage: the model and the cache are this Mac's, so using it on
 * the laptop must not start a 91 MB fetch on the studio Mac.
 *
 * Every access is guarded: the accessor throws where site data is blocked.
 * Semantic search then simply starts at its first use in each session.
 */
export const browserSemanticOptIn: SemanticOptIn = {
  isOn: (vault) => {
    try {
      return window.localStorage.getItem(`${PREFIX}${vault}`) === 'true';
    } catch {
      return false;
    }
  },
  turnOn: (vault) => {
    try {
      window.localStorage.setItem(`${PREFIX}${vault}`, 'true');
    } catch {
      // Safe to ignore: the cache is still kept up for this session, from this use on.
    }
  },
};
