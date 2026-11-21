/** Typing stops for this long, then the note is saved. */
export const AUTOSAVE_DELAY_MS = 300;

export interface Autosave {
  /** Typing happened: save `read()` once typing stops. Reads nothing now, so a keystroke costs nothing. */
  schedule(read: () => string): void;
  /** Saves now, if anything is waiting. Resolves when the save is kept. */
  flush(): Promise<void>;
}

/**
 * Debounced saving for one note. The text is read when the save runs, not
 * on each keystroke; saves never overlap, so they land in the order typed.
 */
export function createAutosave({
  save,
  onError,
  delayMs = AUTOSAVE_DELAY_MS,
}: {
  save: (text: string) => Promise<void>;
  onError: (error: unknown) => void;
  delayMs?: number;
}): Autosave {
  let pending: (() => string) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> = Promise.resolve();

  const flush = (): Promise<void> => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const read = pending;
    pending = null;
    if (read !== null) {
      running = running.then(() => save(read())).catch(onError);
    }
    return running;
  };

  return {
    schedule(read) {
      pending = read;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => void flush(), delayMs);
    },
    flush,
  };
}
