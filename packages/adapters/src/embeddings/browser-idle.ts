import type { IdlePort } from '@dfai/application';

/** The longest the build waits for an idle moment before it takes a turn anyway. */
const AT_MOST_MS = 500;

interface IdleWindow {
  requestIdleCallback?: (callback: () => void, options: { timeout: number }) => number;
  requestAnimationFrame?: (callback: () => void) => number;
}

/**
 * Idle moments in the window. Where the webview has `requestIdleCallback`,
 * that; WebKit does not ship it, so there a turn starts just after a frame
 * is drawn — the rest of that frame is free — with a timer in case no frame
 * comes, as in a hidden window.
 */
export function browserIdle(scope: IdleWindow = globalThis as IdleWindow): IdlePort {
  return {
    idle: () =>
      new Promise<void>((resolve) => {
        if (scope.requestIdleCallback !== undefined) {
          scope.requestIdleCallback(() => resolve(), { timeout: AT_MOST_MS });
          return;
        }
        const fallback = setTimeout(resolve, AT_MOST_MS);
        scope.requestAnimationFrame?.(() =>
          setTimeout(() => {
            clearTimeout(fallback);
            resolve();
          }, 0),
        );
      }),
  };
}
