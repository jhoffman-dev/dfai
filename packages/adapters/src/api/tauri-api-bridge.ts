import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  API_REQUEST_EVENT,
  type ApiBridgePort,
  type ApiRequest,
  type ApiResponse,
} from '@dfai/application';

/**
 * The local API's requests, as the Rust host forwards them: one event per
 * request, answered with `api_respond` (`API_RESPOND_COMMAND` in the contract,
 * written out here so the IPC contract test can see it is registered).
 *
 * The host refuses requests at once until it hears `api_router_ready`, since
 * an event sent before anything listens is lost. Each `serve` names itself to
 * the host, which stays ready while any of them listens: one stopping — the
 * abandoned first mount under React StrictMode, say — never takes readiness
 * from another, whichever of their calls lands last (#158). The name is one the
 * host gives (`api_router_register`), and a page load makes the host refuse
 * every name it gave before: a page already gone that says late it listens
 * cannot mark the API ready with nothing listening (#161).
 */
export const tauriApiBridge: ApiBridgePort = {
  async serve(answer) {
    const listener = await invoke<number>('api_router_register');
    const unlisten = await listen<ApiRequest>(API_REQUEST_EVENT, (event) => {
      answer(event.payload)
        .then(respond)
        .catch(() => {
          // Nobody in the app is waiting on this, and the caller outside it is
          // not left hanging: the host answers it `timeout` when no answer
          // arrives, which is the truth of what happened.
        });
    });
    try {
      await routerReady(listener, true);
    } catch (error) {
      stopListening(unlisten);
      throw error;
    }
    return () => {
      routerReady(listener, false).catch(() => {
        // The host is going away with the page, or never had the API: either
        // way nothing is left to forward requests here.
      });
      stopListening(unlisten);
    };
  },
};

/**
 * `UnlistenFn` is typed `void`, but Tauri's returns the promise of a host call
 * (`plugin:event|unlisten`), which fails when the host is unreachable.
 */
function stopListening(unlisten: () => void): void {
  Promise.resolve(unlisten()).catch(() => {
    // Safe to ignore: this runs as the page goes away or after the host
    // refused the router, and the host forgets the page's listeners on the
    // next page load, so nothing is left forwarding requests here.
  });
}

async function respond({ id, status, body }: ApiResponse): Promise<void> {
  await invoke('api_respond', { id, status, body });
}

async function routerReady(listener: number, ready: boolean): Promise<void> {
  await invoke('api_router_ready', { listener, ready });
}
