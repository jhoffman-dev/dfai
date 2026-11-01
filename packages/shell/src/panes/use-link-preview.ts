import { useQuery } from '@tanstack/react-query';
import type { ObjectType } from '@dfai/domain';
import { readLinkPreview, type LinkPreviewRead } from '@dfai/application';
import type { NotePorts } from '../notes/use-note.ts';
import { scopedReadKey, scopedReadMeta } from '../reads/query-client.ts';

/**
 * What a link's preview card shows of the note it points at (slice 6b),
 * read once per note and kept until that note changes: the index's news
 * reads it again only when it touched the note. Null while it is read, for
 * a note the host cannot read, and for a link to no note.
 */
export function useLinkPreview({
  ports,
  types,
  vault,
  path,
}: {
  ports: NotePorts;
  types: readonly ObjectType[];
  vault: string | null;
  path: string | null;
}): LinkPreviewRead | null {
  // The types' names and labels are in the key: a type renamed reads its cards afresh.
  const labels = types.map((type) => `${type.name}=${type.label}`).join('\u0000');
  const { data } = useQuery({
    queryKey: scopedReadKey(vault ?? '', 'link-preview', path, labels),
    queryFn: () => readLinkPreview({ ...ports, types, path: path ?? '' }),
    meta: scopedReadMeta({ notes: path === null ? [] : [path] }),
    enabled: vault !== null && path !== null,
  });
  return data ?? null;
}
