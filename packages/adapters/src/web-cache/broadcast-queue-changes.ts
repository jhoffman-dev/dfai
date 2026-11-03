import type { SaveQueueChanges } from '@dfai/application';

/** The channel the web build's tabs tell each other the save queue changed on. */
export const SAVE_QUEUE_CHANNEL = 'dfai-save-queue';

/**
 * The page's other tabs, over a BroadcastChannel (#667): a nudge to read the
 * queue again, carrying nothing of it. A browser without one tells nobody;
 * each tab still decides from the store under the lock, so only what it
 * shows waits until its next turn.
 */
export function broadcastQueueChanges(
  open: ((name: string) => BroadcastChannel) | undefined,
): SaveQueueChanges {
  const channel = open?.(SAVE_QUEUE_CHANNEL);
  return {
    announce: () => channel?.postMessage('changed'),
    listen: (listener) => {
      if (channel === undefined) return () => {};
      const heard = () => listener();
      channel.addEventListener('message', heard);
      return () => channel.removeEventListener('message', heard);
    },
  };
}
