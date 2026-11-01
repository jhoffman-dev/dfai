import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { relationTypes, type ObjectType } from '@dfai/domain';
import { notesInUseOfTypes, type IndexPort } from '@dfai/application';
import type { RelationChoice } from '@dfai/ui';
import { errorMessage } from './error-message.ts';

/** The notes each relation column may link, by its key. */
export type RelationChoicesByKey = Readonly<Record<string, readonly RelationChoice[]>>;

/** One relation's notes as last read, and the index they were read from. */
type Read =
  | { readonly indexKey: string; readonly choices: readonly RelationChoice[] }
  | { readonly indexKey: string; readonly problem: string };

/** What has been read, and of which type: another type's relations are other relations. */
interface Reads {
  readonly typeName: string | null;
  readonly byKey: Readonly<Record<string, Read>>;
}

const NOT_READ = 'The notes to link could not be read. Close this and try again.';

/**
 * The notes a view's table offers in each relation cell's picker (#300):
 * read as a picker on that relation opens — never before, so a table nobody
 * links from costs the index nothing — and read again on the next opening
 * once the index has changed, not on every change while no picker is up
 * (#425). A read that fails is said in the picker, and the next opening
 * tries again. The same notes the properties panel offers
 * (`notesInUseOfTypes`).
 */
export function useRelationChoices({
  type,
  index,
  indexKey,
}: {
  type: ObjectType | null;
  index: IndexPort;
  indexKey: string;
}): {
  choices: RelationChoicesByKey;
  /** Why a relation's notes could not be read, by its key. */
  problems: Readonly<Record<string, string>>;
  want: (key: string) => void;
} {
  const typeName = type?.name ?? null;
  const [reads, setReads] = useState<Reads>({ typeName, byKey: {} });
  const shown = reads.typeName === typeName ? reads.byKey : {};
  // Read when a picker opens, not drawn from.
  const latest = useRef({ type, index, indexKey, shown });
  useLayoutEffect(() => {
    latest.current = { type, index, indexKey, shown };
  });

  const want = useCallback((key: string) => {
    const now = latest.current;
    const def = now.type?.properties.find((each) => each.key === key && each.kind === 'relation');
    const was = now.shown[key];
    if (def === undefined || (was !== undefined && fresh(was, now.indexKey))) return;
    const name = now.type?.name ?? null;
    const settle = (read: Read) =>
      setReads((before) => ({
        typeName: name,
        byKey: { ...(before.typeName === name ? before.byKey : {}), [key]: read },
      }));
    notesInUseOfTypes({ index: now.index, types: relationTypes(def) }).then(
      (choices) => settle({ indexKey: now.indexKey, choices }),
      (cause: unknown) =>
        settle({ indexKey: now.indexKey, problem: `${NOT_READ} (${errorMessage(cause)})` }),
    );
  }, []);

  const choices = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(shown).flatMap(([key, read]) =>
          'choices' in read ? [[key, read.choices]] : [],
        ),
      ),
    [shown],
  );
  const problems = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(shown).flatMap(([key, read]) =>
          'problem' in read ? [[key, read.problem]] : [],
        ),
      ),
    [shown],
  );
  return { choices, problems, want };
}

/** Whether a read still stands: it succeeded, from the index as it is now. */
function fresh(read: Read, indexKey: string): boolean {
  return 'choices' in read && read.indexKey === indexKey;
}
