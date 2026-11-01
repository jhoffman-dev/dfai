import { TITLE_KEY, VIEW_ORDER_KEY, viewOrderOf, type SavedViewSummary } from '@dfai/domain';

/**
 * Views this window has written that the catalogue has not read back yet, by
 * path. A type's tabs write a file, then the index is read again — and a
 * person moving a tab twice, or pressing "+" twice, does not wait for that.
 * Each write is asked against the views as they will be, not as last read.
 */
export type UnreadViews = ReadonlyMap<string, SavedViewSummary>;

/**
 * The views as the tabs show them: the catalogue, then the page's own reading
 * of the view it is (which it has before the catalogue does), then what this
 * window wrote and has not read back — each later one winning for its path.
 */
export function viewsAsShown({
  catalogue,
  current,
  unread,
}: {
  catalogue: readonly SavedViewSummary[];
  current: SavedViewSummary | undefined;
  unread: UnreadViews;
}): SavedViewSummary[] {
  const byPath = new Map<string, SavedViewSummary>(catalogue.map((view) => [view.path, view]));
  if (current !== undefined) byPath.set(current.path, current);
  for (const [path, view] of unread) byPath.set(path, view);
  return [...byPath.values()];
}

/** A view as it reads once `values` are written into it: its place, and its title. */
export function withPropertiesWritten(
  view: SavedViewSummary,
  values: Readonly<Record<string, unknown>>,
): SavedViewSummary {
  const title = values[TITLE_KEY];
  return {
    ...view,
    ...(VIEW_ORDER_KEY in values && { order: viewOrderOf(values) }),
    ...(typeof title === 'string' && { title, titleSource: 'property' as const }),
  };
}

/** What is still unread once the catalogue reads a view as it was written. */
export function stillUnread(
  unread: UnreadViews,
  catalogue: readonly SavedViewSummary[],
): Map<string, SavedViewSummary> {
  const read = new Map(catalogue.map((view) => [view.path as string, view]));
  return new Map(
    [...unread].filter(([path, view]) => {
      const reading = read.get(path);
      return reading === undefined || reading.order !== view.order || reading.title !== view.title;
    }),
  );
}
