/**
 * A capture the contract refuses (ADR-0049): every reason it found, not just
 * the first, so the sender can fix them all at once. `POST /v1/captures`
 * answers it as `invalid`; in n8n (#104) the Code node sends the item out of
 * its error output and Slack is told why. Nothing is written for it.
 */
export class CaptureRefusedError extends Error {
  override readonly name = 'CaptureRefusedError';
  readonly reasons: readonly string[];

  constructor(reasons: readonly string[]) {
    super(`The capture was refused: ${reasons.join('; ')}`);
    this.reasons = reasons;
  }
}

/** How much of a value a reason shows: enough to find it, never a message's content. */
const SHOWN_LENGTH = 40;

/**
 * A value as a reason may show it: text quoted and cut to
 * {@link SHOWN_LENGTH} characters, anything else by its type alone. A reason
 * reaches Slack, logs and the API's answer, so it never carries a whole message.
 */
export function shownValue(value: unknown): string {
  if (typeof value !== 'string') {
    if (value === null) return 'null';
    return Array.isArray(value) ? 'a list' : typeof value;
  }
  const characters = [...value];
  const cut = characters.length > SHOWN_LENGTH;
  return JSON.stringify(cut ? `${characters.slice(0, SHOWN_LENGTH).join('')}…` : value);
}

/** The reasons a reading has found so far, each naming the field it is about. */
export class Reasons {
  readonly found: string[] = [];

  add(field: string, reason: string): void {
    this.found.push(`${field}: ${reason}`);
  }

  /** Throws every reason found, when there is one. */
  refuseIfAny(): void {
    if (this.found.length > 0) throw new CaptureRefusedError(this.found);
  }
}
