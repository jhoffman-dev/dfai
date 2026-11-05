import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { Icon } from './icon.tsx';
import { isImeKey } from './ime.ts';
import { KeyHints } from './key-hints.tsx';
import { useReturnFocus, type FocusFallback } from './return-focus.ts';

const HINTS = [
  ['↵', 'to add, and add another'],
  ['esc', 'to close'],
] as const;

/** What came of a capture: taken, or refused with the reason to show. */
export type CaptureOutcome =
  { readonly captured: true } | { readonly captured: false; readonly reason: string };

/**
 * Write a line, get a task.
 *
 * Deliberately one field and nothing else: capture has to be faster than the
 * thought it is capturing, or it does not get used. The field clears only
 * once the capture is taken: refused — a full disk, no connection on the web
 * (#672) — the text stays where it was typed and the reason is said under it.
 *
 * Focus trapping, focus restoration, Escape, the scroll lock and the portal are
 * Base UI's — see ADR-0015. Enter is ours, because Enter here means "capture and
 * stay", which is not a dialog behaviour.
 */
export function CapturePalette({
  destination,
  onCapture,
  onClose,
  fallbackFocus,
  children = null,
}: {
  /** What it will make, so it is clear before pressing Enter. */
  destination: string;
  /** Answers once the capture is written, or refused with the reason. */
  onCapture: (name: string) => Promise<CaptureOutcome>;
  onClose: () => void;
  /** Where focus goes on close if what opened the palette has gone. */
  fallbackFocus?: FocusFallback;
  /** What a paste into the field offered — a Slack message to save (#105) — drawn under it. */
  children?: ReactNode;
}) {
  const finalFocus = useReturnFocus(fallbackFocus);
  const [name, setName] = useState('');
  // Keyed, so the same reason refused twice is a new alert each time and is read again.
  const [refusal, setRefusal] = useState<{ readonly text: string; readonly key: number } | null>(
    null,
  );
  // The captures on their way, by text: a repeat of one of them is not sent again, while
  // another task typed meanwhile goes as its own. The count draws "Saving…".
  const pending = useRef(new Set<string>());
  const [saving, setSaving] = useState(0);
  // What the field holds as a capture comes back, for a refusal to read after its await.
  const fieldNow = useRef(name);
  useEffect(() => {
    fieldNow.current = name;
  }, [name]);

  const refuse = (typed: string, reason: string) => {
    // The text stays to retry: back in the field when it is empty, left where it is when it
    // still holds it. Newer text typed meanwhile is not written over, so the alert names
    // the task that was not added instead.
    const held = fieldNow.current.trim();
    const kept = held === '' || held === typed;
    if (held === '') setName(typed);
    setRefusal((was) => ({
      text: kept ? reason : `${reason} (“${typed}” was not added.)`,
      key: (was?.key ?? 0) + 1,
    }));
  };

  const capture = async (typed: string) => {
    pending.current.add(typed);
    setSaving((count) => count + 1);
    try {
      const outcome = await onCapture(typed);
      if (outcome.captured) {
        // Cleared only while the field still holds what was captured: typing that came
        // after Enter is the next task, not something to wipe.
        setName((now) => (now.trim() === typed ? '' : now));
        setRefusal(null);
      } else refuse(typed, outcome.reason);
    } catch (cause) {
      refuse(typed, cause instanceof Error ? cause.message : String(cause));
    } finally {
      pending.current.delete(typed);
      setSaving((count) => count - 1);
    }
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Viewport className="palette__backdrop">
          <Dialog.Popup className="palette" finalFocus={finalFocus} aria-label="Capture a task">
            <div className="palette__field">
              <Icon name="task" size={19} className="palette__field-icon" />
              <input
                className="palette__input"
                type="text"
                aria-label="What needs doing"
                placeholder="What needs doing?"
                // The app offers to save a pasted Slack message link from here (#105).
                data-paste-offers=""
                value={name}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || isImeKey(event)) return;
                  const typed = name.trim();
                  if (typed === '') {
                    onClose();
                    return;
                  }
                  if (!pending.current.has(typed)) void capture(typed);
                }}
              />
            </div>
            <p className="palette__hint">
              Each one becomes <span className="palette__destination">{destination}</span>.
            </p>
            {saving > 0 && (
              <p className="palette__saving" role="status">
                Saving…
              </p>
            )}
            {refusal !== null && (
              <p key={refusal.key} className="palette__refusal" role="alert">
                {refusal.text}
              </p>
            )}
            {children}
            <KeyHints hints={HINTS} />
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
