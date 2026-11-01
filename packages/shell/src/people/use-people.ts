import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  personChipLookup,
  rankMentionSuggestions,
  type KnownPerson,
  type ObjectType,
  type VaultPath,
} from '@dfai/domain';
import {
  createPerson,
  loadPeople,
  type IndexPort,
  type MarkdownPort,
  type NoteTemplate,
  type VaultFsPort,
} from '@dfai/application';
import type { NotePeople } from '@dfai/ui';

/**
 * The vault's people, read once per index revision, as a note needs them:
 * who `@` offers, making a new person from it, and which links draw as a
 * person's chip. Read only once the index is ready, as the tags are.
 */
export function usePeople({
  ports,
  indexKey,
  ready,
  notePaths,
  types,
  templates,
  onCreated,
}: {
  ports: { fs: VaultFsPort; markdown: MarkdownPort; index: IndexPort };
  indexKey: string;
  ready: boolean;
  notePaths: readonly VaultPath[];
  types: readonly ObjectType[];
  templates: readonly NoteTemplate[];
  /** A person was made: the tree and the index follow them. */
  onCreated: () => void;
}): { people: NotePeople; error: string | null } {
  const [known, setKnown] = useState<readonly KnownPerson[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { fs, markdown, index } = ports;

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    loadPeople({ index })
      .then((people) => {
        if (!cancelled) setKnown(people);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(`The people could not be read: ${messageOf(cause)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [index, indexKey, ready]);

  // People made here, before the tree lists their notes: a link to one is
  // drawn as their chip, and offered, the moment it is written. Kept with the
  // vault they were made in, so another vault never counts them.
  const [made, setMade] = useState<{ fs: VaultFsPort; paths: readonly VaultPath[] } | null>(null);
  const notes = useMemo(() => {
    const listed = new Set<string>(notePaths);
    const unlisted = made?.fs === fs ? made.paths.filter((path) => !listed.has(path)) : [];
    return unlisted.length === 0 ? notePaths : [...notePaths, ...unlisted];
  }, [notePaths, made, fs]);

  const suggest = useCallback(
    (query: string) => rankMentionSuggestions(query, { people: known, linkable: notes }),
    [known, notes],
  );

  const personFor = useMemo(
    () => personChipLookup({ people: new Set<string>(known.map((person) => person.path)), notes }),
    [known, notes],
  );

  const create = useCallback(
    async (name: string) => {
      try {
        const person = await createPerson({
          fs,
          markdown,
          name,
          types,
          templates,
          notePaths: notes,
        });
        setError(null);
        setKnown((was) => [...was, { path: person.path, modified: 0 }]);
        setMade((was) => ({
          fs,
          paths: was?.fs === fs ? [...was.paths, person.path] : [person.path],
        }));
        onCreated();
        return person.target;
      } catch (cause) {
        setError(`${name} could not be added: ${messageOf(cause)}`);
        throw cause;
      }
    },
    [fs, markdown, types, templates, notes, onCreated],
  );

  const notLinked = useCallback((name: string) => {
    setError(
      `${name} was added to People, but not linked: the note changed while they were being made.`,
    );
  }, []);

  const people = useMemo(
    () => ({ suggest, create, personFor, notLinked }),
    [suggest, create, personFor, notLinked],
  );
  return { people, error };
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
