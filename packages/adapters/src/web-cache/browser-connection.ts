import type { ConnectionPort } from '@dfai/application';

/**
 * Whether the browser is online (#667), from `navigator.onLine` and the
 * window's `online` and `offline` events. Thin: "online" only means the
 * browser thinks so; a request that still fails is told apart where it fails.
 */
export function browserConnection(
  page: Pick<Window, 'navigator' | 'addEventListener' | 'removeEventListener'>,
): ConnectionPort {
  return {
    online: () => page.navigator.onLine,
    onChange: (listener) => {
      const online = () => listener(true);
      const offline = () => listener(false);
      page.addEventListener('online', online);
      page.addEventListener('offline', offline);
      return () => {
        page.removeEventListener('online', online);
        page.removeEventListener('offline', offline);
      };
    },
  };
}
