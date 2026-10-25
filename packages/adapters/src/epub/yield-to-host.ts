import type { YieldToHost } from '@dfai/application';

/*
 * The window's turn, between chapters of a long read (#505): a message task,
 * as React's own scheduler takes one, so input and painting come in between.
 * Not a timer — a zero-delay timer is clamped once they nest, and a thousand
 * chapters would wait seconds on it; a message task is only work.
 */
export const yieldToHost: YieldToHost = () =>
  new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
