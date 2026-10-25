import { listAsInput, listFromInput } from '../types/list-input.ts';
import { isNoteProposal, type ProposalNote } from './proposal.ts';

/**
 * A proposal's payload as the Edit form shows it: each thing Accept would
 * write, as text. A link proposal edits only its link; the note and the
 * relation it goes in are what was proposed. A dashboard or a view edits only
 * its name: its widgets, type and layout are what the checker passed.
 */
export type PayloadFields =
  | {
      readonly kind: 'note';
      readonly title: string;
      readonly body: string;
      /** Each property as text, in the payload's order. */
      readonly properties: readonly (readonly [key: string, text: string])[];
    }
  | { readonly kind: 'link'; readonly link: string }
  | { readonly kind: 'spec'; readonly title: string };

/** The payload's fields as the Edit form starts them. */
export function payloadFields(proposal: ProposalNote): PayloadFields {
  if (proposal.kind === 'link') return { kind: 'link', link: proposal.payload.link };
  if (!isNoteProposal(proposal)) return { kind: 'spec', title: proposal.payload.title };
  const { title, body, properties } = proposal.payload;
  return {
    kind: 'note',
    title,
    body,
    properties: Object.entries(properties).map(([key, value]) => [key, propertyText(value)]),
  };
}

/**
 * The payload as edited, ready to be read back through `readProposalPayload`
 * like any other. A property whose text was not changed keeps the value it
 * had, exactly — a record, a list of numbers, no value at all. One that was
 * changed is read back in the shape it had: a list stays a list (quoted items
 * keep their commas), and a number or a yes/no stays one when the text still
 * reads as one.
 */
export function editedPayload(proposal: ProposalNote, fields: PayloadFields): unknown {
  if (proposal.kind === 'link' || fields.kind === 'link') {
    return { ...proposal.payload, link: fields.kind === 'link' ? fields.link : '' };
  }
  if (!isNoteProposal(proposal) || fields.kind === 'spec') {
    return { ...proposal.payload, title: fields.kind === 'note' ? '' : fields.title };
  }
  const { properties: before, folder, linkFrom } = proposal.payload;
  return {
    title: fields.title,
    folder,
    body: fields.body,
    properties: Object.fromEntries(
      fields.properties.map(([key, shown]) => [key, editedValue(shown, before[key])]),
    ),
    // The relation the note joins is what was proposed, as a link proposal's note is.
    ...(linkFrom !== null && { link_from: linkFrom }),
  };
}

function editedValue(shown: string, before: unknown): unknown {
  return shown === propertyText(before) ? before : propertyFromText(shown, before);
}

/** A property's value as one line of text. */
export function propertyText(value: unknown): string {
  if (Array.isArray(value)) return listAsInput(value.map(propertyText));
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Changed text read back into the shape `before` had. */
export function propertyFromText(shown: string, before: unknown): unknown {
  const trimmed = shown.trim();
  if (Array.isArray(before)) {
    const numbers = before.length > 0 && before.every((item) => typeof item === 'number');
    return listFromInput(shown).map((item) => (numbers ? numberOr(item) : item));
  }
  if (typeof before === 'number') return trimmed === '' ? shown : numberOr(trimmed);
  if (typeof before === 'boolean' && (trimmed === 'true' || trimmed === 'false')) {
    return trimmed === 'true';
  }
  if (isRecord(before)) return recordOr(shown);
  return shown;
}

/** The text as a number, when it reads as one; the text otherwise. */
function numberOr(text: string): number | string {
  return Number.isFinite(Number(text)) ? Number(text) : text;
}

/** The text as the record it spells in JSON, when it does; the text otherwise. */
function recordOr(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : text;
  } catch {
    // Not JSON: what was typed is kept as typed, as any other text is.
    return text;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
