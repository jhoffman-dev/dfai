import { useMemo, useRef } from 'react';
import { replaceEqualDeep, useQuery } from '@tanstack/react-query';
import { objectTypeIcon, type ObjectType, type QuickViewId } from '@dfai/domain';
import {
  countNotesByType,
  countQuickViews,
  readAtlasFolder,
  readSidebarMarks,
  sidebarCatalogOf,
  type IndexPort,
  type MarkdownPort,
  type SidebarCatalog,
  type VaultFsPort,
} from '@dfai/application';
import type { SidebarQuickView, SidebarType } from '@dfai/ui';
import { vaultReadKey } from '../reads/query-client.ts';

const NOTHING: SidebarCatalog = {
  views: [],
  dashboards: [],
  favorites: [],
  quick: [],
  savedViews: [],
  queryViews: [],
  takenViewPaths: [],
};

/**
 * What the derived sections of the sidebar show, each part a read the window
 * keeps until what it is made from changes (#293): the notes under `.atlas`
 * when a file there does, the marks the index holds and the Today and Inbox
 * counts, and the types' counts, whenever the index has news
 * (`readsTouchedByPaths`, `READS_ON_INDEX_NEWS`).
 *
 * Nothing here is a second list: every section is read back from the files and
 * the index, so starring a note in one place and opening it in another cannot
 * disagree. What reads the same as before is the same object as before, so a
 * section whose rows did not change is not drawn again.
 */
export function useSidebarCatalog({
  fs,
  markdown,
  index,
  types,
  notePaths,
  vaultKey,
  indexReady,
}: {
  fs: VaultFsPort;
  markdown: MarkdownPort;
  index: IndexPort;
  types: readonly ObjectType[];
  /** Every note in the vault, so a link in a query view's text names the note it means. */
  notePaths: readonly string[];
  vaultKey: string | null;
  /** Whether the index has been built: the types are counted only then. */
  indexReady: boolean;
}): {
  catalog: SidebarCatalog;
  sidebarTypes: readonly SidebarType[];
  quick: readonly SidebarQuickView[];
} {
  const catalog = useCatalog({ fs, markdown, index, vaultKey });
  const typeNames = useMemo(() => types.map((type) => type.name), [types]);
  // Spelled once per read of the types, not hashed by the cache on every render.
  const typesSpelled = useMemo(() => JSON.stringify(types), [types]);
  const vault = vaultKey ?? '';
  const counts = useQuery({
    queryKey: [...vaultReadKey(vault, 'type-counts'), typeNames],
    queryFn: () => typeCounts(index, types),
    enabled: vaultKey !== null && indexReady,
  });
  // Read when a count runs, not a reason to run one: a new note moves the index, which counts again.
  const notePathsNow = useRef(notePaths);
  notePathsNow.current = notePaths;
  const quickPaths = useMemo(() => catalog.quick.map(({ entry }) => entry.path), [catalog.quick]);
  const quickCounts = useQuery({
    // The definitions, not only their names: a query view is checked against them,
    // so a type defined anew under the same name is counted with the new one.
    queryKey: [...vaultReadKey(vault, 'quick-counts'), quickPaths, typesSpelled],
    queryFn: async () =>
      Object.fromEntries(
        await countQuickViews({
          fs,
          markdown,
          index,
          quick: catalog.quick,
          types,
          notePaths: notePathsNow.current,
        }),
      ) as Partial<Record<QuickViewId, number>>,
    enabled: vaultKey !== null,
  });

  const sidebarTypes = useMemo(
    () =>
      types.map((type) => ({
        name: type.name,
        label: type.label,
        count: counts.data?.[type.name] ?? 0,
        icon: objectTypeIcon(type),
      })),
    [types, counts.data],
  );
  const quick = useMemo(
    () =>
      catalog.quick.map(({ id, entry }) => ({ id, entry, count: quickCounts.data?.[id] ?? null })),
    [catalog.quick, quickCounts.data],
  );
  return { catalog, sidebarTypes, quick };
}

/**
 * The catalogue from its two reads, once both have answered. One that failed
 * keeps what it last read, and is read again when the index next has news.
 */
function useCatalog({
  fs,
  markdown,
  index,
  vaultKey,
}: {
  fs: VaultFsPort;
  markdown: MarkdownPort;
  index: IndexPort;
  vaultKey: string | null;
}): SidebarCatalog {
  const vault = vaultKey ?? '';
  // Kept as lists, not maps, so a read the same as the last is the same data.
  const marks = useQuery({
    queryKey: vaultReadKey(vault, 'sidebar-marks'),
    queryFn: async () => [...(await readSidebarMarks(index))],
    enabled: vaultKey !== null,
  });
  const atlas = useQuery({
    queryKey: vaultReadKey(vault, 'sidebar-atlas'),
    queryFn: async () => {
      const { notes, inViewsFolder } = await readAtlasFolder({ fs, markdown });
      return { notes: [...notes], inViewsFolder };
    },
    enabled: vaultKey !== null,
  });
  const answered = (read: { data?: unknown; error: unknown }) =>
    read.data !== undefined || read.error !== null;
  const ready = vaultKey !== null && answered(marks) && answered(atlas);
  const made = useMemo(
    () =>
      ready
        ? sidebarCatalogOf({
            indexed: new Map(marks.data ?? []),
            atlas: {
              notes: new Map(atlas.data?.notes ?? []),
              inViewsFolder: atlas.data?.inViewsFolder ?? [],
            },
          })
        : NOTHING,
    [ready, marks.data, atlas.data],
  );
  // Each section the same as before stays the same object, so it is not drawn again.
  const last = useRef(NOTHING);
  last.current = replaceEqualDeep(last.current, made);
  return last.current;
}

/**
 * How many notes each type has. A count the index could not answer fails the
 * read, rather than being kept as zero: it is read again on the index's next news.
 */
async function typeCounts(
  index: IndexPort,
  types: readonly ObjectType[],
): Promise<Readonly<Record<string, number>>> {
  const failures: unknown[] = [];
  const counted = await countNotesByType({
    index,
    types,
    onFailed: (cause) => failures.push(cause),
  });
  const [cause] = failures;
  if (failures.length > 0) {
    console.error('The types’ counts could not be read:', cause);
    throw cause instanceof Error ? cause : new Error(String(cause));
  }
  return Object.fromEntries(counted);
}
