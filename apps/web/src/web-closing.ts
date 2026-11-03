import type { WindowClosingPort } from '@dfai/application';

/**
 * The window's close, as the web build says it (#667): nothing closes the
 * page here, but a sign-out has the shell's panes write what waits in
 * their autosave first, through the same tasks a closing window runs, and
 * is handed back what failed to be written.
 */
export function webClosing(): WindowClosingPort & { close(): Promise<readonly unknown[]> } {
  const tasks = new Set<() => Promise<void>>();
  return {
    beforeClose: async (task) => {
      tasks.add(task);
      return () => void tasks.delete(task);
    },
    // One failing never keeps the others from writing; every failure is handed back, never swallowed.
    close: async () =>
      (await Promise.allSettled([...tasks].map((task) => task()))).flatMap((result) =>
        result.status === 'rejected' ? [result.reason as unknown] : [],
      ),
  };
}
