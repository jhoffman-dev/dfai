/**
 * A view as a caller describes one (P32-05, `make_dashboard`): its name, the
 * type whose notes it lists and how it draws them — the three things the New
 * view dialog asks — checked by the dialog's own rules (`newViewFieldProblems`),
 * so a caller hears what the dialog would say.
 */

import type { SpecProblem } from '../errors/spec-problem.ts';
import type { ObjectType } from '../types/property-def.ts';
import { hiddenCharacterProblem } from './entry-name-characters.ts';
import { newViewFieldProblems, type NewViewRequest } from './new-view.ts';
import type { ViewLayout } from './saved-view.ts';

export type ViewSpecReading =
  | { readonly ok: true; readonly request: NewViewRequest }
  | { readonly ok: false; readonly problems: readonly SpecProblem[] };

/**
 * The view `value` describes, or everything wrong with it. A name already
 * taken is not wrong here: it is numbered past when the view is written,
 * which may be long after it is asked for.
 */
export function checkViewSpec(
  value: Readonly<Record<string, unknown>>,
  { types }: { types: readonly ObjectType[] },
): ViewSpecReading {
  const fields = ['name', 'type', 'layout'] as const;
  const notText = fields.filter((field) => typeof value[field] !== 'string');
  if (notText.length > 0) {
    return {
      ok: false,
      problems: notText.map((field) => ({ at: field, message: `${field} must be text.` })),
    };
  }
  const request: NewViewRequest = {
    name: String(value['name']).trim(),
    type: String(value['type']).trim(),
    layout: String(value['layout']).trim() as ViewLayout,
  };
  const hidden = hiddenCharacterProblem(String(value['name']), 'view');
  const problems = [
    ...(hidden === null ? [] : [{ at: 'name', message: hidden }]),
    ...newViewFieldProblems(request, { types, takenPaths: [] }),
  ];
  return problems.length > 0 ? { ok: false, problems } : { ok: true, request };
}
