/**
 * Making a view: what it is called, which notes it lists and how it draws them.
 *
 * A view is a note in `.atlas/views`, so making one is choosing a file name
 * and writing the frontmatter the view parser reads. Everything a layout needs
 * that the person did not pick — the property a board groups by, the date a
 * calendar places notes on — is taken from the type, so the view draws as
 * asked the moment it opens rather than falling back to a table.
 */

import type { SpecProblem } from '../errors/spec-problem.ts';
import { BLOCK_CALENDAR, isBlockType } from '../timeblocks/block-type.ts';
import type { ObjectType, PropertyDef, PropertyKind } from '../types/property-def.ts';
import { MAX_NAME_BYTES } from '../vault/file-name-bytes.ts';
import { ATLAS_DIRECTORY } from '../vault/vault-visibility.ts';
import { createVaultPath, type VaultPath } from '../vault/vault-path.ts';
import { DEFAULT_QUERY_LIMIT } from './view-query.ts';
import { VIEW_LAYOUTS, VIEW_MARKER, VIEW_MARKER_VALUE, type ViewLayout } from './saved-view.ts';

/** Where every saved view lives. */
export const VIEWS_FOLDER = `${ATLAS_DIRECTORY}/views`;

/** The property kinds a board can make columns of. */
export const GROUPABLE_KINDS: readonly PropertyKind[] = ['select', 'relation', 'checkbox'];

/** Characters no filesystem the vault may sit on accepts in a name. */
const UNUSABLE_IN_NAME = /[/\\:*?"<>|]|\p{Cc}/u;
const UNUSABLE_IN_NAME_ALL = new RegExp(UNUSABLE_IN_NAME.source, 'gu');

/** What a view's file name ends in. */
const VIEW_EXTENSION = '.md';

/** What a view is called when nothing of the name asked for can be a file name. */
const FALLBACK_VIEW_NAME = 'View';

const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export interface NewViewRequest {
  readonly name: string;
  /** The type whose notes the view lists. */
  readonly type: string;
  readonly layout: ViewLayout;
}

/** The note a new view is written as. */
export interface NewViewNote {
  readonly path: VaultPath;
  readonly frontmatter: Readonly<Record<string, unknown>>;
}

/** What a layout is called where one is picked: its name, capitalised. */
export function layoutLabel(layout: ViewLayout): string {
  return layout.charAt(0).toUpperCase() + layout.slice(1);
}

/** The path a view of this name is written to. */
export function viewPathFor(name: string): VaultPath {
  return createVaultPath(`${VIEWS_FOLDER}/${name.trim()}.md`);
}

/** The properties of a type a board can group by, in the order the type declares them. */
export function groupableProperties(type: ObjectType | null): PropertyDef[] {
  return (type?.properties ?? []).filter((property) => GROUPABLE_KINDS.includes(property.kind));
}

function dateProperties(type: ObjectType): PropertyDef[] {
  return type.properties.filter((property) => property.kind === 'date');
}

/**
 * Why this name cannot be a view's, or null. Blank, a character a file name
 * cannot hold, a leading dot (which would hide it) or a view already called
 * that — in any case and either Unicode normalisation, since APFS looks a name
 * up both ways and would refuse the second file.
 */
export function viewNameProblem(name: string, takenPaths: readonly string[]): string | null {
  const problem = entryNameProblem(name, 'view');
  if (problem !== null) return problem;
  const trimmed = name.trim();
  const path = sameFileKey(viewPathFor(trimmed));
  if (takenPaths.some((taken) => sameFileKey(taken) === path)) {
    return `There is already a view called “${trimmed}”.`;
  }
  return null;
}

/**
 * Why this name cannot be the file name of one of DFAI's own entries — a
 * view or a dashboard — or null: blank, a character no disk accepts, a
 * leading dot (which would hide it), or too long for a file name.
 */
export function entryNameProblem(name: string, noun: 'view' | 'dashboard'): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return `Name the ${noun}.`;
  if (UNUSABLE_IN_NAME.test(trimmed)) return `A ${noun}’s name cannot hold / \\ : * ? " < > or |.`;
  if (trimmed.startsWith('.')) return `A ${noun}’s name cannot start with a dot.`;
  if (utf8Bytes(`${trimmed}${VIEW_EXTENSION}`) > MAX_NAME_BYTES) {
    return `A ${noun}’s name is too long for a file name.`;
  }
  return null;
}

/** What two paths share when a case- and normalisation-insensitive disk takes them for one file. */
function sameFileKey(path: string): string {
  return path.normalize('NFC').toLowerCase();
}

/**
 * `name` as a view's file can be called, with room left for `ending` (" 2"):
 * a dash for each character no disk accepts, no leading dot, and cut — by
 * whole characters as a reader sees them, never half an emoji — until the file
 * name fits in {@link MAX_NAME_BYTES}. What the person typed is kept as the
 * view's title wherever this differs from it.
 */
export function usableViewName(name: string, ending = ''): string {
  const cleaned = name.replace(UNUSABLE_IN_NAME_ALL, '-').trim().replace(/^\.+/, '').trim();
  const room = MAX_NAME_BYTES - utf8Bytes(`${ending}${VIEW_EXTENSION}`);
  let kept = '';
  for (const { segment } of graphemes.segment(cleaned)) {
    if (utf8Bytes(kept + segment) > room) break;
    kept += segment;
  }
  return kept.trim() === '' ? FALLBACK_VIEW_NAME : kept.trimEnd();
}

/** Why a type cannot be drawn in a layout, or null when it can. */
export function layoutProblem(layout: ViewLayout, type: ObjectType): string | null {
  if (!VIEW_LAYOUTS.includes(layout)) return `There is no layout called “${layout}”.`;
  if (layout === 'board' && groupableProperties(type).length === 0) {
    return `A board needs a property to group by, and ${type.label} has none.`;
  }
  if ((layout === 'calendar' || layout === 'timeline') && dateProperties(type).length === 0) {
    return `A ${layout} needs a date, and ${type.label} has no date property.`;
  }
  return null;
}

/** Everything wrong with a request, in words, or nothing. */
export function newViewProblems(
  request: NewViewRequest,
  checked: { types: readonly ObjectType[]; takenPaths: readonly string[] },
): string[] {
  return newViewFieldProblems(request, checked).map(({ message }) => message);
}

/**
 * Everything wrong with a request, each with the field it is about — `name`,
 * `type` or `layout` — in the words {@link newViewProblems} gives.
 */
export function newViewFieldProblems(
  request: NewViewRequest,
  { types, takenPaths }: { types: readonly ObjectType[]; takenPaths: readonly string[] },
): SpecProblem[] {
  const problems: SpecProblem[] = [];
  const nameProblem = viewNameProblem(request.name, takenPaths);
  if (nameProblem !== null) problems.push({ at: 'name', message: nameProblem });

  const type = types.find((candidate) => candidate.name === request.type);
  if (type === undefined) {
    const message = request.type.trim() === '' ? 'Choose a type.' : 'That type no longer exists.';
    problems.push({ at: 'type', message });
    return problems;
  }
  const layout = layoutProblem(request.layout, type);
  if (layout !== null) problems.push({ at: 'layout', message: layout });
  return problems;
}

/**
 * The note a new view is written as. Call only once `newViewProblems` is empty:
 * the settings a layout needs are the type's first property that can supply them.
 */
export function newViewNote(request: NewViewRequest, type: ObjectType): NewViewNote {
  return {
    path: viewPathFor(request.name),
    frontmatter: {
      [VIEW_MARKER]: VIEW_MARKER_VALUE,
      type: type.name,
      layout: request.layout,
      ...layoutSettings(request.layout, type),
      columns: type.properties.map((property) => property.key),
      limit: DEFAULT_QUERY_LIMIT,
    },
  };
}

function layoutSettings(layout: ViewLayout, type: ObjectType): Record<string, string> {
  const [firstDate, secondDate] = dateProperties(type);
  const [firstGroup] = groupableProperties(type);
  if (layout === 'board' && firstGroup !== undefined) return { groupBy: firstGroup.key };
  if (layout === 'calendar' && isBlockType(type.name)) return { ...BLOCK_CALENDAR };
  if (layout === 'calendar' && firstDate !== undefined) return { dateKey: firstDate.key };
  if (layout === 'timeline' && firstDate !== undefined) {
    return {
      startKey: firstDate.key,
      ...(secondDate === undefined ? {} : { endKey: secondDate.key }),
    };
  }
  return {};
}
