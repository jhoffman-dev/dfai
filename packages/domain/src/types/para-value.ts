import { foldedTypeName, foldedTypeSql } from './note-type-sql.ts';
import { humanizeKey } from '../page/property-label.ts';
import type { CompiledQuery } from '../query/view-query.ts';
import {
  ARCHIVED_PARA,
  AREA_TYPE,
  DEFAULT_PARA,
  PARA_BEFORE_ARCHIVE_KEY,
  PARA_KEY,
  PARA_VALUES,
  PROJECT_TYPE,
  RESOURCE_TYPE,
  type ParaValue,
} from './para.ts';
import type { ObjectType } from './property-def.ts';

type Properties = Readonly<Record<string, unknown>>;

/** A value as PARA compares it: text, trimmed, in any case; anything else is no name. */
const folded = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';

/** The PARA value `value` names, in any case, or null when it names none of the four. */
export function paraValueNamed(value: unknown): ParaValue | null {
  const name = folded(value);
  return PARA_VALUES.find((candidate) => candidate === name) ?? null;
}

/** Whether a note is PARA's: its `type` is Project. Only these are archived by their value. */
export function isParaNote(properties: Properties): boolean {
  return folded(properties['type']) === PROJECT_TYPE;
}

/**
 * Where a note stands in PARA, from its `type` and its `para`: a Project's
 * `para`, or the default when it has none DFAI can read; a note of the
 * Area or Resource type from before #213 as the value its type names. Null
 * for a note of any other type.
 */
export function paraOf({ type, para }: { type: unknown; para: unknown }): ParaValue | null {
  const kind = folded(type);
  if (kind === PROJECT_TYPE) return paraValueNamed(para) ?? DEFAULT_PARA;
  if (kind === AREA_TYPE || kind === RESOURCE_TYPE) return kind;
  return null;
}

/** Whether a note is a Project set to archive: out of the way, though its file has not moved. */
export function isParaArchived(properties: Properties): boolean {
  return isParaNote(properties) && paraValueNamed(properties[PARA_KEY]) === ARCHIVED_PARA;
}

/** What a note's `para` holds: nothing, a PARA value, or something of the person's own. */
function heldPara(value: unknown): ParaValue | 'none' | 'own' {
  if (value === undefined || value === null) return 'none';
  if (typeof value === 'string' && value.trim() === '') return 'none';
  return paraValueNamed(value) ?? 'own';
}

/**
 * Whether a note's `para` is the person's own — a value that is none of
 * PARA's four, or a list or a map — which DFAI never writes over.
 */
export function holdsOwnPara(properties: Properties): boolean {
  return heldPara(properties[PARA_KEY]) === 'own';
}

const PARA_KINDS: readonly string[] = [PROJECT_TYPE, AREA_TYPE, RESOURCE_TYPE];

/**
 * What archiving a PARA note writes into it where it stands (#213) — its
 * `para` set to archive, and what it was kept under `para_before_archive`
 * for Unarchive to give back — or null when it is not archived by its value
 * and the Archive takes it by moving its file: a note of no PARA type, or
 * one whose `para` is the person's own.
 *
 * A note of the Area or Resource type from before #213 is a Project once it
 * is archived, with what its type was kept: archived is a Project's PARA,
 * and means nothing on another type. In a vault with no Project type to put
 * it on (`projectType` null) it is moved instead.
 *
 * A Project already archived has nothing to write: no changes at all.
 */
export function paraArchiveChanges({
  properties,
  projectType,
}: {
  properties: Properties;
  /** The vault's Project type's name, as `type:` is to say it; null when it has none. */
  projectType: string | null;
}): Readonly<Record<string, string>> | null {
  const kind = folded(properties['type']);
  const held = heldPara(properties[PARA_KEY]);
  if (!PARA_KINDS.includes(kind) || held === 'own') return null;
  if (kind === PROJECT_TYPE) {
    const before = held === 'none' ? DEFAULT_PARA : held;
    if (before === ARCHIVED_PARA) return {};
    return { [PARA_KEY]: ARCHIVED_PARA, [PARA_BEFORE_ARCHIVE_KEY]: before };
  }
  if (projectType === null) return null;
  return { type: projectType, [PARA_KEY]: ARCHIVED_PARA, [PARA_BEFORE_ARCHIVE_KEY]: kind };
}

/**
 * The vault's Project type's name, as a note's `type:` is to say it: as its
 * file spells it when one file claims it, `project` when two do — which one
 * a feature reads is not for a writer to pick — and null when it has none.
 */
export function vaultProjectTypeName(types: readonly Pick<ObjectType, 'name'>[]): string | null {
  const projects = types.filter((type) => folded(type.name) === PROJECT_TYPE);
  const [project] = projects;
  if (project === undefined) return null;
  return projects.length === 1 ? project.name : PROJECT_TYPE;
}

/** Whether Archive puts this note away by its `para`, where it stands, rather than by moving its file. */
export function archivesWhereItStands(properties: Properties): boolean {
  return paraArchiveChanges({ properties, projectType: PROJECT_TYPE }) !== null;
}

/**
 * What unarchiving a Project writes into it (#213): its `para` back to what
 * `para_before_archive` kept — Project when nothing readable was kept — and
 * that record taken off. A Project whose `para` is not archive has only the
 * record taken off, if it has one. Null when there is nothing to write: a
 * note of any other type, or one whose `para` is the person's own.
 */
export function paraUnarchiveChanges(
  properties: Properties,
): Readonly<Record<string, string | null>> | null {
  if (folded(properties['type']) !== PROJECT_TYPE) return null;
  const held = heldPara(properties[PARA_KEY]);
  if (held === 'own') return null;
  const recorded = Object.hasOwn(properties, PARA_BEFORE_ARCHIVE_KEY);
  if (held !== ARCHIVED_PARA) return recorded ? { [PARA_BEFORE_ARCHIVE_KEY]: null } : null;
  const before = paraValueNamed(properties[PARA_BEFORE_ARCHIVE_KEY]);
  const restored = before === null || before === ARCHIVED_PARA ? DEFAULT_PARA : before;
  return { [PARA_KEY]: restored, [PARA_BEFORE_ARCHIVE_KEY]: null };
}

/** Whether a relation's target is a PARA value, so it resolves to the Project type. */
export function isParaTarget(target: string): boolean {
  const name = folded(target);
  return name === PROJECT_TYPE || name === AREA_TYPE || name === RESOURCE_TYPE;
}

/**
 * The PARA values a relation pointing at `targets` offers, in PARA's order:
 * `[project, area]` offers projects and areas, `area` only areas. Archive is
 * never one: an archived note is out of the way.
 */
export function paraValuesTargeted(targets: readonly string[]): ParaValue[] {
  const named = new Set(targets.map(folded));
  return PARA_VALUES.filter((value) => value !== ARCHIVED_PARA && named.has(value));
}

/** A note a PARA relation may offer, with where it stands in PARA. */
export interface ParaChoice {
  readonly path: string;
  readonly title: string;
  readonly para: ParaValue;
}

/**
 * What a relation pointing at `targets` offers of PARA's notes: the ones
 * whose value it points at, grouped as PARA reads — projects, then areas,
 * then resources — each group in the order given. Never an archived one.
 */
export function paraChoices<Choice extends ParaChoice>(
  notes: readonly Choice[],
  targets: readonly string[],
): Choice[] {
  return paraValuesTargeted(targets).flatMap((value) =>
    notes.filter((note) => note.para === value),
  );
}

const GROUP_LABELS: Readonly<Record<ParaValue, string>> = {
  project: 'Projects',
  area: 'Areas',
  resource: 'Resources',
  archive: 'Archive',
};

/** The heading a picker groups a relation's notes under: PARA's by value, any other by its type. */
export function relationGroupLabel(type: string): string {
  const value = paraValueNamed(type);
  return value === null ? humanizeKey(type) : GROUP_LABELS[value];
}

/**
 * The type a picker's "New area…" makes a note of, and what it is given: for
 * a PARA target, a Project whose PARA is the value named — when the vault's
 * Project type declares PARA (#213); otherwise the type the target names, as
 * for any relation. Null when the vault has no type to make it of.
 */
export function relatedNoteKind<Type extends Pick<ObjectType, 'name' | 'properties'>>({
  target,
  types,
}: {
  target: string;
  types: readonly Type[];
}): { readonly type: Type; readonly values: Readonly<Record<string, string>> } | null {
  const value = isParaTarget(target) ? paraValueNamed(target) : null;
  const project = types.find((type) => folded(type.name) === PROJECT_TYPE);
  const holdsPara = project?.properties.some((property) => property.key === PARA_KEY) === true;
  if (value !== null && project !== undefined && holdsPara) {
    return { type: project, values: { [PARA_KEY]: value } };
  }
  const named = types.find((type) => type.name === target);
  return named === undefined ? null : { type: named, values: {} };
}

/**
 * What a new note of `type` starts with besides what it was given: on a
 * Project type that declares `para`, the default — unless its fields or its
 * template already say one.
 */
export function paraDefaultFor({
  type,
  starting,
}: {
  type: Pick<ObjectType, 'name' | 'properties'>;
  /** What the new note says already: its template's frontmatter and the fields filled in. */
  starting: Properties;
}): Properties {
  if (folded(type.name) !== PROJECT_TYPE) return {};
  if (!type.properties.some((property) => property.key === PARA_KEY)) return {};
  const said = starting[PARA_KEY];
  if (said !== undefined && said !== null && String(said).trim() !== '') return {};
  return { [PARA_KEY]: DEFAULT_PARA };
}

/**
 * A SQL condition that keeps Project notes set to archive — archived where
 * they stand — for a statement whose rows carry a note's path in `column`,
 * written qualified (`"v_project"."path"`, `n.path`), since it is compared
 * inside a subquery over `props`. Constants of the app only, so nothing is bound.
 */
export function paraArchivedSql(column: string): string {
  return [
    `EXISTS (SELECT 1 FROM props AS para_value WHERE para_value.path = ${column}`,
    `  AND para_value.key = '${PARA_KEY}' AND lower(trim(para_value.value_text)) = '${ARCHIVED_PARA}'`,
    `  AND EXISTS (SELECT 1 FROM props AS para_type WHERE para_type.path = ${column}`,
    `    AND para_type.key = 'type' AND lower(trim(para_type.value_text)) = '${PROJECT_TYPE}'))`,
  ].join('\n');
}

/**
 * A SQL condition that leaves out the Project notes at `column` whose first
 * `para` value is archive — the value a picker reads ({@link compileParaValuesQuery}
 * keeps each note's first), so that what a count leaves out is what a picker
 * does not offer. One value, which is how a `para` is written, reads the same
 * either way; this differs from {@link paraArchivedSql} only for a list.
 * Constants of the app only, so nothing is bound.
 */
export function outsideFirstParaArchiveSql(column: string): string {
  return [
    `NOT EXISTS (SELECT 1 FROM props AS para_value WHERE para_value.path = ${column}`,
    `  AND para_value.key = '${PARA_KEY}' AND lower(trim(para_value.value_text)) = '${ARCHIVED_PARA}'`,
    `  AND para_value.idx = (SELECT MIN(first_para.idx) FROM props AS first_para`,
    `    WHERE first_para.path = ${column} AND first_para.key = '${PARA_KEY}')`,
    `  AND EXISTS (SELECT 1 FROM props AS para_type WHERE para_type.path = ${column}`,
    `    AND para_type.key = 'type' AND lower(trim(para_type.value_text)) = '${PROJECT_TYPE}'))`,
  ].join('\n');
}

/** A SQL condition that leaves out Project notes set to archive: see {@link paraArchivedSql}. */
export function outsideParaArchiveSql(column: string): string {
  return `NOT ${paraArchivedSql(column)}`;
}

/** Of the Project notes at `column`, those whose `para` names none of `values`. Constants only. */
function paraNoneOfSql(column: string, values: readonly ParaValue[]): string {
  const named = values.map((value) => `'${value}'`).join(', ');
  return [
    `NOT EXISTS (SELECT 1 FROM props AS para_value WHERE para_value.path = ${column}`,
    `  AND para_value.key = '${PARA_KEY}' AND lower(trim(para_value.value_text)) IN (${named}))`,
  ].join('\n');
}

/**
 * A SQL condition that keeps, of the Project notes at `column`, the projects:
 * those whose `para` names no other PARA value — none, `project`, or one
 * DFAI cannot read, which is the default. Constants only, nothing bound.
 */
export function paraProjectSql(column: string): string {
  return paraNoneOfSql(
    column,
    PARA_VALUES.filter((value) => value !== DEFAULT_PARA),
  );
}

/**
 * A SQL condition that keeps, of the Project notes at `column`, what notes
 * are filed under: projects and areas — never a resource or an archived
 * one. A `para` DFAI cannot read is the default, a project.
 */
export function paraFiledUnderSql(column: string): string {
  return paraNoneOfSql(column, [RESOURCE_TYPE, ARCHIVED_PARA]);
}

/** What {@link compileParaValuesQuery}'s statement starts with, so a log or a stand-in index can tell it apart. */
export const PARA_VALUES_QUERY_MARK = '/* PARA values */';

/** The columns {@link compileParaValuesQuery} comes back as, in order. */
export const PARA_VALUES_QUERY_COLUMNS = ['path', 'para'] as const;

/**
 * Every note of the type `typeName` — in any case, as FROM finds it — that
 * holds a `para`, and what that says: what a picker groups the type's notes by.
 */
export function compileParaValuesQuery(typeName: string): CompiledQuery {
  return {
    sql: [
      `${PARA_VALUES_QUERY_MARK} SELECT para_value.path AS "path", para_value.value_text AS "para"`,
      `FROM props AS para_value`,
      `WHERE para_value.key = '${PARA_KEY}'`,
      `  AND EXISTS (SELECT 1 FROM props AS para_type WHERE para_type.path = para_value.path`,
      `    AND para_type.key = 'type' AND ${foldedTypeSql('para_type.value_text')} = ?)`,
      `ORDER BY para_value.path, para_value.idx`,
    ].join('\n'),
    parameters: [foldedTypeName(typeName)],
  };
}
