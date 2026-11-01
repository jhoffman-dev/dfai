import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createWindowQueryClient } from './query-client.ts';

/** A window's query cache for a hook under test, and the wrapper that provides it. Test support. */
export function queryWrapper(): {
  client: QueryClient;
  wrapper: (props: { children: ReactNode }) => ReactNode;
} {
  const client = createWindowQueryClient();
  return {
    client,
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  };
}
