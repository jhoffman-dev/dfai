/** A rule that reads every meeting a second time, and what is said of it (#793). */
export interface ReadTwiceView {
  /** The rule's name: what the offer turns off. */
  readonly rule: string;
  readonly warning: string;
}

/**
 * Says that every meeting is read twice, rule by rule, with an offer to turn
 * the second reader off. Nothing is turned off until it is clicked.
 */
export function ReadTwiceNotice({
  readTwice,
  busy,
  onTurnOff,
  className,
}: {
  readTwice: readonly ReadTwiceView[];
  busy: boolean;
  onTurnOff: (rule: string) => void;
  className: string;
}) {
  if (readTwice.length === 0) return null;
  return (
    <>
      {readTwice.map(({ rule, warning }) => (
        <div key={rule} className={className} role="note" aria-label="Every meeting is read twice">
          <p>{warning}</p>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            disabled={busy}
            onClick={() => onTurnOff(rule)}
          >
            Turn off “{rule}”
          </button>
        </div>
      ))}
    </>
  );
}
