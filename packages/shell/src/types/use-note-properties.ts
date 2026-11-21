import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  dueOf,
  humanizeKey,
  isTaskNote,
  notePropertyKind,
  relationTypes,
  TASK_KEYS,
  validatePropertyValue,
  type ObjectType,
  type PropertyDef,
  type PropertyKind,
  type VaultPath,
} from '@dfai/domain';
import { isDatasource, isSavedView } from '@dfai/domain';
import { ranksKnownTasks } from './use-types.ts';
import {
  linkedTypeProblems,
  noteTypeName,
  notesInUseOfTypes,
  type IndexPort,
  type MarkdownPort,
  type OpenNote,
  type VaultFsPort,
} from '@dfai/application';
import type { PropertyRow, RelationChoice, RelationTarget } from '@dfai/ui';

const NO_KINDS: Readonly<Record<string, PropertyKind>> = {};

/**
 * A key found in the note but not declared by its type, shown rather than
 * hidden, with the editor its value calls for.
 */
function undeclared(key: string, kind: PropertyKind, value: unknown): PropertyDef {
  return {
    key,
    kind,
    label: humanizeKey(key),
    required: false,
    options: [],
    target: null,
    // Links written as a list are a relation to several notes.
    many: kind === 'relation' && Array.isArray(value),
  };
}

/**
 * The rows the properties panel shows for the open note.
 *
 * Declared properties come first, in the order the type lists them, then anything
 * else the file happens to contain — a property the type does not know about is
 * still in the file, and hiding it would make the panel lie about the note.
 */
export function useNoteProperties({
  note,
  types,
  index,
  links,
}: {
  note: OpenNote | null;
  types: readonly ObjectType[];
  index: IndexPort;
  /** What a relation's links are checked against: a link to a note of the wrong type is a problem (P30-01). */
  links?: {
    readonly fs: Pick<VaultFsPort, 'readNotes'>;
    readonly markdown: Pick<MarkdownPort, 'frontmatterProperties'>;
    readonly notePaths: readonly VaultPath[];
  };
}): {
  typeName: string | null;
  /** The type as a person reads it; null for a note with none. */
  typeLabel: string | null;
  /** The types a new relation can point at. */
  relationTargets: readonly RelationTarget[];
  /**
   * Remembers the kind a property was added to this note as, while its empty
   * value cannot say — a number just added is a number field before it is 412.
   */
  rememberKind: (key: string, kind: PropertyKind) => void;
  rows: readonly PropertyRow[];
  /** Every key in the note's frontmatter, shown as a row or not. */
  keys: readonly string[];
  relationChoices: Readonly<Record<string, readonly RelationChoice[]>>;
} {
  const properties = useMemo(() => note?.properties ?? {}, [note]);

  // In a saved view, `type` names the notes the view lists rather than what this
  // note is. Showing a properties panel for it would edit the wrong thing.
  const isView = useMemo(() => isSavedView(properties), [properties]);
  // A source's `type` names the notes it produces, for the same reason — but a
  // source is configured through its own properties, so its rows stay.
  const namesOtherNotes = useMemo(() => isView || isDatasource(properties), [isView, properties]);
  const typeName = useMemo(
    () => (namesOtherNotes ? null : noteTypeName(properties)),
    [namesOtherNotes, properties],
  );
  const type = useMemo(
    () => types.find((candidate) => candidate.name === typeName) ?? null,
    [types, typeName],
  );
  // A task in a vault that ranks its tasks 1 to 4 picks its `priority` as None or P1 to P4 (#913).
  const isTask = typeName !== null && isTaskNote({ type: typeName });
  const ranked = useMemo(() => isTask && ranksKnownTasks(types), [types, isTask]);

  /** Kinds given to properties added to this note alone, for the note they were added to. */
  const [added, setAdded] = useState<{
    path: string | null;
    kinds: Readonly<Record<string, PropertyKind>>;
  }>({ path: null, kinds: {} });
  const path = note?.path ?? null;
  const addedKinds = useMemo(() => (added.path === path ? added.kinds : NO_KINDS), [added, path]);
  const rememberKind = useCallback(
    (key: string, kind: PropertyKind) =>
      setAdded((was) => ({
        path,
        kinds: { ...(was.path === path ? was.kinds : {}), [key]: kind },
      })),
    [path],
  );

  const linkProblems = useLinkedTypeProblems({ type, properties, links });

  const rows = useMemo<PropertyRow[]>(() => {
    if (note === null || isView) return [];

    const declared = type?.properties ?? [];
    const declaredKeys = new Set(declared.map((def) => def.key));
    const extras = Object.keys(properties).filter(
      (key) => key !== 'type' && !declaredKeys.has(key),
    );
    const extraKind = (key: string): PropertyKind =>
      addedKinds[key] ?? notePropertyKind(properties[key], key);

    return [
      ...declared,
      ...extras.map((key) => undeclared(key, extraKind(key), properties[key])),
    ].map((def) => {
      const value = properties[def.key] ?? null;
      // A task's priority is a soft field (#913): any value is kept and picked
      // over as "Other: …", so its row is never judged by its kind.
      if (ranked && def.key === TASK_KEYS.priority) {
        return { def, editor: 'priority' as const, value, error: null };
      }
      // A task's due that holds a day takes an optional time of day (#928): one
      // with none to give it to — empty, `next Friday` — would write nothing.
      const takesTime =
        isTask && def.key === TASK_KEYS.due && def.kind === 'date' && dueOf(value) !== null;
      return {
        def,
        value,
        error: validatePropertyValue({ def, value }) ?? linkProblems[def.key] ?? null,
        ...(takesTime && { editor: 'dueTime' as const }),
      };
    });
  }, [note, isView, type, properties, addedKinds, linkProblems, ranked, isTask]);

  const [relationChoices, setRelationChoices] = useState<
    Readonly<Record<string, readonly RelationChoice[]>>
  >({});

  useEffect(() => {
    const relations = (type?.properties ?? []).filter(
      (def) => def.kind === 'relation' && def.target !== null,
    );
    if (relations.length === 0) {
      setRelationChoices({});
      return;
    }

    let cancelled = false;
    Promise.all(
      relations.map(
        async (def) =>
          [def.key, await notesInUseOfTypes({ index, types: relationTypes(def) })] as const,
      ),
    )
      .then((pairs) => {
        if (!cancelled) setRelationChoices(Object.fromEntries(pairs));
      })
      .catch(() => {
        // An index that is not ready yet offers nothing rather than everything.
        if (!cancelled) setRelationChoices({});
      });

    return () => {
      cancelled = true;
    };
  }, [type, index]);

  const keys = useMemo(() => Object.keys(properties), [properties]);
  const relationTargets = useMemo(
    () => types.map((candidate) => ({ name: candidate.name, label: candidate.label })),
    [types],
  );

  return {
    typeName,
    typeLabel: type?.label ?? null,
    relationTargets,
    rememberKind,
    rows,
    keys,
    relationChoices,
  };
}

const NO_PROBLEMS: Readonly<Record<string, string>> = {};

/** Why each relation cannot hold what it links, read from the linked notes' own types. */
function useLinkedTypeProblems({
  type,
  properties,
  links,
}: {
  type: ObjectType | null;
  properties: Readonly<Record<string, unknown>>;
  links:
    | {
        readonly fs: Pick<VaultFsPort, 'readNotes'>;
        readonly markdown: Pick<MarkdownPort, 'frontmatterProperties'>;
        readonly notePaths: readonly VaultPath[];
      }
    | undefined;
}): Readonly<Record<string, string>> {
  const [problems, setProblems] = useState<Readonly<Record<string, string>>>(NO_PROBLEMS);
  useEffect(() => {
    if (type === null || links === undefined) {
      setProblems(NO_PROBLEMS);
      return;
    }
    let cancelled = false;
    linkedTypeProblems({ ...links, properties: type.properties, values: properties })
      .then((found) => {
        if (!cancelled) setProblems(found);
      })
      .catch(() => {
        // A linked note that cannot be read right now is not judged; the link stays as written.
        if (!cancelled) setProblems(NO_PROBLEMS);
      });
    return () => {
      cancelled = true;
    };
  }, [type, properties, links]);
  return problems;
}
