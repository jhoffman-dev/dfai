import { matchingCommands, type ObjectType, type PaletteCommand } from '@dfai/domain';

const EDIT_TYPE = 'edit-type:';
const EDIT_TEMPLATE = 'edit-template:';

/**
 * "Edit Task type" and "Edit Task template" in the search palette, one of each
 * per type (ADR-0023, ADR-0026): a click on a type lands on its views, so its
 * definition and its template need a way in besides the buttons beside its
 * tabs and its sidebar menu.
 *
 * Offered only once the query starts with "edit". A type's name is an everyday
 * search word, and a command it matched would sit above — and be chosen
 * before — the notes the search found.
 */
export function paletteEditTypeOffers(
  types: readonly Pick<ObjectType, 'name' | 'label'>[],
  query: string,
): PaletteCommand[] {
  if (!/^\s*edit\b/i.test(query)) return [];
  const commands = types.flatMap((type) => [
    { id: `${EDIT_TYPE}${type.name}`, label: `Edit ${type.label} type` },
    { id: `${EDIT_TEMPLATE}${type.name}`, label: `Edit ${type.label} template` },
  ]);
  return matchingCommands(query, commands);
}

/** Opens the type or template a command names; false when `id` is not one of these commands. */
export function runPaletteEditTypeCommand(
  id: string,
  {
    editType,
    editTemplate,
  }: { editType: (name: string) => void; editTemplate: (name: string) => void },
): boolean {
  if (id.startsWith(EDIT_TYPE)) editType(id.slice(EDIT_TYPE.length));
  else if (id.startsWith(EDIT_TEMPLATE)) editTemplate(id.slice(EDIT_TEMPLATE.length));
  else return false;
  return true;
}
