import { PERIOD_ITEM_KEY, PERIOD_RULE_KEY } from '../automations/output-period.ts';
import { BLOCK_TYPE } from '../timeblocks/block-type.ts';

/**
 * The notes that carry an event's keys but are never an event's note: a
 * morning brief (#39), by its period stamps, and a time block (ADR-0030), by
 * its type in any case. `type` alone decides nothing else — it is the
 * person's key (ADR-0046), so an event note retyped by hand is still the
 * event's. {@link notEventNoteSql} and {@link isNotEventNote} say the same.
 */
const STAMP_KEYS = [PERIOD_ITEM_KEY, PERIOD_RULE_KEY] as const;

/** SQL that holds for a path that is not such a note, with its parameters, in order. */
export function notEventNoteSql(column: string): {
  sql: string;
  parameters: string[];
} {
  return {
    sql: `${column} NOT IN (SELECT path FROM props WHERE key IN (?, ?))
     AND ${column} NOT IN (SELECT path FROM props WHERE key = 'type' AND lower(trim(value_text)) = ?)`,
    parameters: [...STAMP_KEYS, BLOCK_TYPE],
  };
}

/** The values a property is indexed as, one row each: an array's items at any depth. */
const rowsOf = (value: unknown): unknown[] =>
  Array.isArray(value) ? value.flat(Infinity) : [value];

/**
 * Whether a note's properties make it one that is never an event's note, as
 * the index reads them for {@link notEventNoteSql}: a stamp key with any
 * value, or a `type` row of `block`.
 */
export function isNotEventNote(properties: Readonly<Record<string, unknown>>): boolean {
  const stamped = STAMP_KEYS.some((key) => key in properties && rowsOf(properties[key]).length > 0);
  const block = rowsOf(properties['type']).some(
    (value) => typeof value === 'string' && value.trim().toLowerCase() === BLOCK_TYPE,
  );
  return stamped || block;
}
