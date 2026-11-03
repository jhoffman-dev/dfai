import { memo, useRef } from 'react';
import {
  changedOn,
  isLibraryFiltered,
  NO_LIBRARY_FILTER,
  LIBRARY_KIND_HUES,
  SOURCE_KIND_LABELS,
  withToggled,
  type LibraryChoices,
  type LibraryEntry,
  type LibraryFilter,
  type LibrarySort,
  type LibrarySortKey,
  type VaultPath,
} from '@dfai/domain';
import { CardCover, type CoverSource } from '../card-cover.tsx';
import { ChoiceSelect } from '../choice-select.tsx';
import { Icon } from '../icon.tsx';
import { openHowFrom, type OpenHow } from '../open-how.ts';
import { PageBar, type PageHistory } from '../page-bar.tsx';
import { HiddenTitle } from '../page-head.tsx';
import { ROW_SCROLLER_MARK, RowScrollerContext } from '../row-scroller.ts';
import {
  ChipToggles,
  ClearFilters,
  FilterSelect,
  ResearchNotice,
  shownCount,
  type ResearchListState,
} from './research-filters.tsx';
import { ResearchRows, type RowPlace } from './research-rows.tsx';

export interface LibraryPageProps {
  readonly state: ResearchListState<LibraryEntry>;
  readonly choices: LibraryChoices;
  readonly filter: LibraryFilter;
  readonly onFilter: (filter: LibraryFilter) => void;
  readonly sort: LibrarySort;
  readonly onSort: (sort: LibrarySort) => void;
  /** Each source's cover, read from the vault only as its row is drawn. */
  readonly covers: CoverSource;
  readonly onOpen: (path: VaultPath, how: OpenHow) => void;
  readonly onShowSidebar?: () => void;
  readonly history?: PageHistory;
}

/** A row's height before it is measured: a cover's. */
const ROW_HEIGHT = 64;

const SORTS: readonly { value: LibrarySortKey; label: string }[] = [
  { value: 'modified', label: 'Last changed' },
  { value: 'title', label: 'Title' },
  { value: 'author', label: 'Author' },
  { value: 'highlights', label: 'Highlights' },
];

const keyOf = (entry: LibraryEntry) => entry.path;

/**
 * The Library (#507): every literature note — a PDF, an EPUB, a Kindle book —
 * with its cover when the vault holds one, its author, kind, how many
 * highlights it has and when it last changed. Filtered by kind, tag and
 * project, searched by title and author, sorted; each row opens its note.
 */
export function LibraryPage(props: LibraryPageProps) {
  const { state, filter, onFilter } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const count = shownCount(state, ['source', 'sources']);
  return (
    <>
      <PageBar
        crumb={{ icon: 'library', parent: 'Library' }}
        name="Library"
        {...(count !== null && { count })}
        actions={
          <label className="page-search research__search">
            <Icon name="search" size={14} />
            <input
              type="search"
              className="page-search__input"
              placeholder="Search titles and authors…"
              aria-label="Search the Library"
              value={filter.search}
              onChange={(event) => onFilter({ ...filter, search: event.target.value })}
            />
          </label>
        }
        {...(props.onShowSidebar !== undefined && { onShowSidebar: props.onShowSidebar })}
        {...(props.history !== undefined && { history: props.history })}
      />
      <div className="panel__body panel__body--rows" ref={scroller} {...ROW_SCROLLER_MARK}>
        <RowScrollerContext.Provider value={scroller}>
          <article className="page page--wide research" aria-label="Library">
            <HiddenTitle>Library</HiddenTitle>
            <LibraryToolbar {...props} />
            <ResearchNotice
              state={state}
              reading="Reading the Library…"
              none="No sources yet. A PDF, an EPUB or a Kindle book gets a literature note here once it is imported or synced."
              noMatch="No source matches."
            />
            {state.kind === 'ready' && state.shown.length > 0 && (
              <ResearchRows
                items={state.shown}
                keyOf={keyOf}
                estimate={ROW_HEIGHT}
                label="Sources"
                renderRow={(entry, place) => (
                  <LibraryRow
                    key={entry.path}
                    entry={entry}
                    index={place.index}
                    size={place.size}
                    measure={place.measure}
                    covers={props.covers}
                    onOpen={props.onOpen}
                  />
                )}
              />
            )}
          </article>
        </RowScrollerContext.Provider>
      </div>
    </>
  );
}

function LibraryToolbar({ choices, filter, onFilter, sort, onSort }: LibraryPageProps) {
  return (
    <div className="research__toolbar">
      <ChipToggles
        label="Kind"
        choices={choices.kinds}
        on={filter.kinds}
        hueOf={(kind) => LIBRARY_KIND_HUES[kind]}
        onToggle={(kind) => onFilter({ ...filter, kinds: withToggled(filter.kinds, kind) })}
      />
      <FilterSelect
        label="Tag"
        every="Any tag"
        value={filter.tag}
        choices={choices.tags}
        onChange={(tag) => onFilter({ ...filter, tag })}
      />
      <FilterSelect
        label="Project"
        every="Any project"
        value={filter.project}
        choices={choices.projects}
        onChange={(project) => onFilter({ ...filter, project })}
      />
      {isLibraryFiltered(filter) && <ClearFilters onClear={() => onFilter(NO_LIBRARY_FILTER)} />}
      <span className="research__sort">
        <ChoiceSelect
          label="Sort by"
          className="research__select"
          value={sort.key}
          choices={SORTS}
          onChange={(key) => onSort({ ...sort, key })}
        />
        <button
          type="button"
          className="btn btn--sm research__direction"
          aria-label={sort.descending ? 'Descending' : 'Ascending'}
          aria-pressed={sort.descending}
          onClick={() => onSort({ ...sort, descending: !sort.descending })}
        >
          <Icon name={sort.descending ? 'down' : 'up'} size={14} />
        </button>
      </span>
    </div>
  );
}

/** One source. Drawn again only when its own entry, place or handlers change, not as the list scrolls. */
const LibraryRow = memo(function LibraryRow({
  entry,
  index,
  size,
  measure,
  covers,
  onOpen,
}: {
  entry: LibraryEntry;
  index: number;
  size: number;
  measure: RowPlace['measure'];
  covers: CoverSource;
  onOpen: (path: VaultPath, how: OpenHow) => void;
}) {
  const count = `${entry.highlights.toLocaleString('en-US')} ${entry.highlights === 1 ? 'highlight' : 'highlights'}`;
  return (
    <li
      ref={measure}
      data-index={index}
      className="research__row library__row"
      aria-setsize={size}
      aria-posinset={index + 1}
    >
      <span className="library__cover" aria-hidden="true">
        <CardCover path={entry.path} covers={covers} fallback={<Icon name="book" size={18} />} />
      </span>
      <button
        type="button"
        className="research__open"
        onClick={(event) => onOpen(entry.path, openHowFrom(event))}
      >
        <span className="research__title">{entry.title}</span>
        {entry.author !== null && <span className="research__byline">{entry.author}</span>}
      </button>
      {entry.kind !== null && (
        <span className="research__kind" data-hue={LIBRARY_KIND_HUES[entry.kind]}>
          {SOURCE_KIND_LABELS[entry.kind]}
        </span>
      )}
      <span className="research__count">{count}</span>
      {entry.modified !== null && (
        <span className="research__date">{changedOn(entry.modified)}</span>
      )}
    </li>
  );
});
