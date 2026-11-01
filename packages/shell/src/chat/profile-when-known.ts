import type { ProfileState } from '@dfai/domain';

/** The profile the chat is handed, kept current by the app and asked for with each question. */
export interface ProfileSource {
  /** What the app now knows of the person. */
  readonly set: (profile: ProfileState) => void;
  /**
   * The profile for a question. The first question asked waits up to `waitMs`
   * for a profile that is still unknown — at launch the settings note is
   * usually a moment from being read — rather than tell the model to ask for a
   * name it is about to have. Later questions are handed what is known now.
   */
  readonly get: () => Promise<ProfileState>;
}

export function profileWhenKnown({ waitMs }: { waitMs: number }): ProfileSource {
  let current: ProfileState = 'unknown';
  let asked = false;
  const waiting = new Set<() => void>();
  return {
    set(profile) {
      current = profile;
      if (profile === 'unknown') return;
      for (const wake of [...waiting]) wake();
    },
    get() {
      const first = !asked;
      asked = true;
      if (current !== 'unknown' || !first) return Promise.resolve(current);
      return new Promise((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          waiting.delete(wake);
          resolve(current);
        };
        const timer = setTimeout(wake, waitMs);
        waiting.add(wake);
      });
    },
  };
}
