import type { ExternalLinkPort } from '@dfai/application';

/** Opens a page in a new tab, as `window.open` does. */
export type OpenWindow = (url: string, target: string, features: string) => unknown;

/** The schemes a link may have: the web's, as the desktop's `opener.rs` allows. */
const WEB_SCHEMES = new Set(['http:', 'https:']);

/**
 * Opens a web link in a new tab (#774), with no way back to this page
 * (`noopener`) and no referrer. Only http and https: anything else could
 * reach the device or run in this page, so it is refused, as on the desktop.
 */
export function browserExternalLinks(
  open: OpenWindow = (url, target, features) => window.open(url, target, features),
): ExternalLinkPort {
  return {
    open(url) {
      let parsed: URL;
      try {
        parsed = new URL(url.trim());
      } catch {
        return Promise.reject(new Error(`“${url}” is not a link that can be opened.`));
      }
      if (!WEB_SCHEMES.has(parsed.protocol)) {
        return Promise.reject(new Error(`Only web links can be opened, not ${parsed.protocol}`));
      }
      open(parsed.href, '_blank', 'noopener,noreferrer');
      return Promise.resolve();
    },
  };
}
