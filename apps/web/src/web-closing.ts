import type { WindowClosingPort } from '@dfai/application';

/**
 * The window's close, as the web build says it (#667): nothing closes the
 * page here, but a sign-out has the shell's panes write what waits in
 * their autosave first, through the same tasks a closing window runs.
 */
export function webClosing(): WindowClosingPort & { close(): Promise<void> } {
  const tasks = new Set<() => Promise<void>>();
  return {
    beforeClose: async (task) => {
      tasks.add(task);
      return () => void tasks.delete(task);
    },
    // Each task's failure is its own to report; one failing never keeps the others from writing.
    close: async () => void (await Promise.allSettled([...tasks].map((task) => task()))),
  };
}
