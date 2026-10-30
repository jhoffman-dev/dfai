import type { ObjectType, PropertyDef } from '../types/property-def.ts';
import { listFromInput } from '../types/list-input.ts';
import type { VaultPath } from '../vault/vault-path.ts';
import { QUICK_ADD_DEFAULT } from './quick-add-types.ts';

/** How many properties quick add asks for beside the title: more is a form, not a quick add. */
export const QUICK_ADD_FIELD_LIMIT = 3;

/**
 * The properties worth asking for while adding a note quickly, in the order
 * they are asked: whatever the type requires, then its first choice (a
 * task's status), then what it links to (a task's project), then its first
 * date (a task's due date) — at most three, each once.
 *
 * A checkbox is left out unless required: unticked is what it starts as anyway.
 */
export function quickAddFields(type: Pick<ObjectType, 'properties'>): readonly PropertyDef[] {
  const { properties } = type;
  const wanted = [
    ...properties.filter((property) => property.required),
    ...properties.filter((property) => property.kind === 'select').slice(0, 1),
    ...properties.filter((property) => property.kind === 'relation'),
    ...properties.filter((property) => property.kind === 'date').slice(0, 1),
  ];
  const unique = wanted.filter((property, at) => wanted.indexOf(property) === at);
  return unique.slice(0, QUICK_ADD_FIELD_LIMIT);
}

/**
 * What a quick-added note's frontmatter is changed by: its type, and every
 * field that was filled in, as the value its kind stores — a number as a
 * number, a relation to several notes as a list. An empty field is left out
 * rather than written as nothing, so a template's own value for it stands.
 */
export function quickAddProperties({
  type,
  fields,
  values,
}: {
  type: Pick<ObjectType, 'name'>;
  fields: readonly PropertyDef[];
  values: Readonly<Record<string, string>>;
}): Record<string, unknown> {
  const filled = fields
    .filter((field) => field.key !== 'type')
    .map((field) => [field.key, storedValue(field, (values[field.key] ?? '').trim())] as const)
    .filter(([, value]) => value !== null);
  return { type: type.name, ...Object.fromEntries(filled) };
}

function storedValue(field: PropertyDef, typed: string): unknown {
  if (typed === '') return null;
  if (field.kind === 'number') {
    const number = Number(typed);
    return Number.isFinite(number) ? number : typed;
  }
  if (field.kind === 'checkbox') return typed === 'true';
  if (field.kind === 'multiSelect') {
    // Typed as the properties panel takes a list: a choice holding a comma is quoted.
    const choices = listFromInput(typed);
    return choices.length === 0 ? null : choices;
  }
  if (field.kind === 'relation' && field.many) return [typed];
  return typed;
}

/**
 * The note a quick-added note goes beside when its type has no home folder
 * (#214): a task goes where a captured one (Shift+Cmd+N) once did — beside
 * the note in view — since quick add is capture with a few fields; anything
 * else beside nothing, so at the root, as "New <type>" on a type's table puts it.
 */
export function quickAddBeside({
  type,
  beside,
}: {
  type: Pick<ObjectType, 'name'>;
  beside: VaultPath | null;
}): VaultPath | null {
  return type.name === QUICK_ADD_DEFAULT ? beside : null;
}
