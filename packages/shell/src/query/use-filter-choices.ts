import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  filterChoices,
  NO_CHOICE_SOURCES,
  type FilterChoice,
  type FilterChoiceSources,
  type NoteNames,
  type ObjectType,
} from '@dfai/domain';
import { loadFilterChoiceSources, type IndexPort } from '@dfai/application';

/** Each property's filter choices, by key. */
export type FilterChoicesByKey = Readonly<Record<string, readonly FilterChoice[]>>;

const NONE_WANTED: readonly string[] = [];

/** The properties whose choices have been asked for, and of which type. */
interface WantedKeys {
  readonly typeName: string | null;
  readonly keys: readonly string[];
}

/**
 * What the Filter control offers for each property of a view's type (#212):
 * a select's options at once, and a relation's notes and the vault's tags
 * once they are wanted — when a value box opens on that property, or a filter
 * on it is listed — and the index has answered; again whenever it changes.
 * Until then nothing is read, so a view nobody filters costs the index nothing.
 */
export function useFilterChoices({
  type,
  index,
  indexKey,
  names,
}: {
  type: ObjectType | null;
  index: IndexPort;
  indexKey: string;
  names: NoteNames;
}): { choices: FilterChoicesByKey; want: (key: string) => void } {
  const [sources, setSources] = useState<FilterChoiceSources>(NO_CHOICE_SOURCES);
  const typeName = type?.name ?? null;
  // Held with the type it was asked of: another type's properties are other properties.
  const [asked, setAsked] = useState<WantedKeys>({ typeName, keys: NONE_WANTED });
  const wanted = asked.typeName === typeName ? asked.keys : NONE_WANTED;

  const want = useCallback(
    (key: string) =>
      setAsked((was) => {
        const keys = was.typeName === typeName ? was.keys : NONE_WANTED;
        return keys.includes(key) ? was : { typeName, keys: [...keys, key] };
      }),
    [typeName],
  );

  useEffect(() => {
    if (type === null || wanted.length === 0) {
      setSources(NO_CHOICE_SOURCES);
      return;
    }
    let cancelled = false;
    loadFilterChoiceSources({ index, type, names, keys: wanted })
      .then((loaded) => {
        if (!cancelled) setSources(loaded);
      })
      .catch(() => {
        // An index that is not ready yet offers no notes or tags; the
        // options still show, and any value can still be typed.
        if (!cancelled) setSources(NO_CHOICE_SOURCES);
      });
    return () => {
      cancelled = true;
    };
  }, [index, type, indexKey, names, wanted]);

  const choices = useMemo(
    () =>
      Object.fromEntries(
        (type?.properties ?? []).map((property) => [
          property.key,
          filterChoices(property, sources),
        ]),
      ),
    [type, sources],
  );
  return { choices, want };
}
