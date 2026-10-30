/** A key, or a chord of keys, as plain metadata text: ⌘K, ↵, esc. */
export function Key({ children }: { children: string }) {
  return <kbd className="key">{children}</kbd>;
}

/** Each hint: the keys, space-separated, and what they do. */
type Hints = readonly (readonly [keys: string, does: string])[];

/**
 * The keys an overlay answers to, along its foot. Decoration for sighted
 * keyboard users: the controls themselves carry their own names, so a screen
 * reader is not read the list twice.
 */
export function KeyHints({ hints }: { hints: Hints }) {
  return keyHintStrip({ hints });
}

/**
 * The strip itself, as elements rather than components: a page's strip
 * (#109) is drawn with the page, and each component it held would be a
 * render the work budgets count. Given a `label`, it is read too — a page's
 * keys are said nowhere else but in `aria-keyshortcuts`.
 */
export function keyHintStrip({ hints, label }: { hints: Hints; label?: string }) {
  return (
    <footer
      className={label === undefined ? 'key-hints' : 'key-hints key-hints--page'}
      {...(label === undefined ? { 'aria-hidden': true } : { role: 'note', 'aria-label': label })}
    >
      {hints.map(([keys, does]) => (
        <span key={does} className="key-hints__hint">
          {keys.split(' ').map((key) => (
            <kbd key={key} className="key">
              {key}
            </kbd>
          ))}
          {does}
        </span>
      ))}
    </footer>
  );
}
