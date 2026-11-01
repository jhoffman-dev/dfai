import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  createVaultPath,
  relationTypes,
  wikiLinkTargetFor,
  type ObjectType,
  type QueryField,
} from '@dfai/domain';
import { loadTagCounts, notesInUseOfType, type IndexPort } from '@dfai/application';
import type { Choice } from '@dfai/ui';

const NONE: readonly string[] = [];

/**
 * What the builder's dropdowns offer (P24-02): the vault's types, the notes a
 * relation can point at — each as the link that names it — and the tags in use.
 * Read from the index when the fields that need them appear, and again when
 * the index changes.
 */
export function useQueryChoices({
  index,
  types,
  fields,
  notePaths,
  indexKey,
}: {
  index: IndexPort;
  types: readonly ObjectType[];
  fields: readonly QueryField[];
  notePaths: readonly string[];
  indexKey: string;
}) {
  // Keyed by the names, so a new list of the same targets asks the index nothing.
  const targetKey = [...new Set(fields.flatMap((field) => relationTypes(field)))].join(',');
  const targets = useMemo(() => (targetKey === '' ? [] : targetKey.split(',')), [targetKey]);
  const wantsTags = fields.some((field) => field.kind === 'tag');
  const notes = useNotesOfTypes({ index, targets, notePaths, indexKey });
  const tags = useTagNames({ index, wanted: wantsTags, indexKey });

  const valueChoices = useCallback(
    (field: QueryField): readonly string[] => {
      if (field.kind === 'tag') return tags;
      const [only, ...more] = relationTypes(field);
      if (only === undefined) return NONE;
      if (more.length === 0) return notes.get(only) ?? NONE;
      // A relation to several types offers the notes of each, in the order it names them.
      return [only, ...more].flatMap((type) => notes.get(type) ?? NONE);
    },
    [notes, tags],
  );

  const typeChoices = useMemo<Choice[]>(
    () => types.map((type) => ({ value: type.name, label: type.label })),
    [types],
  );

  return { typeChoices, valueChoices };
}

function useNotesOfTypes({
  index,
  targets,
  notePaths,
  indexKey,
}: {
  index: IndexPort;
  targets: readonly string[];
  notePaths: readonly string[];
  indexKey: string;
}): ReadonlyMap<string, readonly string[]> {
  const [notes, setNotes] = useState<ReadonlyMap<string, readonly string[]>>(new Map());
  useEffect(() => {
    let cancelled = false;
    const paths = notePaths.map(createVaultPath);
    Promise.all(
      targets.map(async (type) => {
        const found = await notesInUseOfType({ index, type });
        const links = found.map((note) => wikiLinkTargetFor(createVaultPath(note.path), paths));
        return [type, links.sort((a, b) => a.localeCompare(b))] as const;
      }),
    )
      .then((entries) => {
        if (!cancelled) setNotes(new Map(entries));
      })
      .catch(() => {
        // An index still opening offers nothing to pick; a name can still be typed as text.
        if (!cancelled) setNotes(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [index, targets, notePaths, indexKey]);
  return notes;
}

function useTagNames({
  index,
  wanted,
  indexKey,
}: {
  index: IndexPort;
  wanted: boolean;
  indexKey: string;
}): readonly string[] {
  const [tags, setTags] = useState<readonly string[]>(NONE);
  useEffect(() => {
    if (!wanted) return;
    let cancelled = false;
    loadTagCounts({ index })
      .then((counts) => {
        if (!cancelled) setTags(counts.map((count) => count.name));
      })
      .catch(() => {
        // As above: nothing to pick from yet, and a tag can still be typed.
        if (!cancelled) setTags(NONE);
      });
    return () => {
      cancelled = true;
    };
  }, [index, wanted, indexKey]);
  return tags;
}
