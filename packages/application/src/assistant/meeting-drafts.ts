/**
 * The meetings being drafted now (P32-05), one set per router: asking again
 * about a meeting while its draft runs is refused rather than paying Claude
 * for a second answer.
 */
export interface MeetingDrafts {
  /** Claims the key; false when a draft holds it already. */
  start(key: string): boolean;
  /** Lets the key go, once its draft has stopped however it stopped. */
  finish(key: string): void;
}

export function createMeetingDrafts(): MeetingDrafts {
  const running = new Set<string>();
  return {
    start: (key) => {
      if (running.has(key)) return false;
      running.add(key);
      return true;
    },
    finish: (key) => {
      running.delete(key);
    },
  };
}
