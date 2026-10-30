import { memo, type ReactNode } from 'react';
import type { ChipIcon, PropertyIcon, SidebarIcon, WidgetIcon, WidgetKind } from '@dfai/domain';

/*
 * The app's glyphs, drawn inline on a 24-unit grid in `currentColor`, so each
 * one takes the colour of the text around it. The paths are the mockup's
 * (design/target/Sidebar.dc.html); `list`, `split` and `close` are drawn to
 * match them. A handful of shapes does not earn an icon library.
 */

const line = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8 } as const;
const round = { ...line, strokeLinecap: 'round' } as const;
const joined = { ...line, strokeLinejoin: 'round' } as const;

const GLYPHS = {
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" {...line} />
      <path d="M16 16l4.5 4.5" {...round} />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" {...line} />
      <path
        d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"
        {...round}
      />
    </>
  ),
  moon: <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" {...joined} />,
  plus: <path d="M12 5v14M5 12h14" {...round} strokeWidth={1.9} />,
  table: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="3" {...line} />
      <path d="M3.5 10h17M9.5 10v9.5" {...line} />
    </>
  ),
  board: (
    <>
      <rect x="3.5" y="4.5" width="5" height="15" rx="1.8" {...line} />
      <rect x="10.5" y="4.5" width="5" height="10" rx="1.8" {...line} />
      <rect x="17.5" y="4.5" width="3.5" height="6.5" rx="1.5" {...line} />
    </>
  ),
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15.5" rx="3" {...line} />
      <path d="M3.5 10h17M8 3v4M16 3v4" {...round} />
    </>
  ),
  timeline: <path d="M4 7h9M8 12h11M6 17h8" {...round} strokeWidth={2.2} />,
  feed: (
    <>
      <rect x="4" y="4" width="16" height="7" rx="2" {...joined} />
      <path d="M4 15h16M4 19h11" {...round} />
    </>
  ),
  list: (
    <>
      <path d="M9 7h11M9 12h11M9 17h11" {...round} />
      <circle cx="4.8" cy="7" r="1.3" fill="currentColor" />
      <circle cx="4.8" cy="12" r="1.3" fill="currentColor" />
      <circle cx="4.8" cy="17" r="1.3" fill="currentColor" />
    </>
  ),
  inbox: (
    <path
      d="M3.5 13.5L6.2 5.5h11.6l2.7 8v5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z M3.5 13.5h5l1.5 2.2h4l1.5-2.2h5"
      {...joined}
    />
  ),
  chart: (
    <path d="M5 19.5V11M10.3 19.5V5M15.6 19.5v-6.5M20.5 19.5V8.5" {...round} strokeWidth={2.2} />
  ),
  artifact: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="3" {...line} />
      <path d="M3.5 9h17" {...line} />
      <path d="M10 12.5l-2.2 2.2 2.2 2.2M14 12.5l2.2 2.2-2.2 2.2" {...round} {...joined} />
    </>
  ),
  deck: (
    <>
      <rect x="3.5" y="5.5" width="17" height="11" rx="2.5" {...line} />
      <path d="M12 16.5v3M8.5 19.5h7" {...round} />
    </>
  ),
  design: (
    <>
      <circle cx="8" cy="8" r="3.5" {...line} />
      <rect x="11.5" y="11.5" width="8" height="8" rx="2" {...line} />
      <path d="M4.5 19.5l4-6.5 4 6.5z" {...joined} />
    </>
  ),
  grid: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="2" {...line} />
      <rect x="13.5" y="3.5" width="7" height="7" rx="2" {...line} />
      <rect x="3.5" y="13.5" width="7" height="7" rx="2" {...line} />
      <rect x="13.5" y="13.5" width="7" height="7" rx="2" {...line} />
    </>
  ),
  task: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="4.5" {...line} />
      <path d="M8.5 12.3l2.4 2.4 4.8-5.1" {...round} {...joined} strokeWidth={1.9} />
    </>
  ),
  person: (
    <>
      <circle cx="12" cy="8.5" r="3.8" {...line} />
      <path d="M4.8 20c1.3-3.6 4-5.4 7.2-5.4s5.9 1.8 7.2 5.4" {...round} />
    </>
  ),
  company: (
    <path
      d="M4.5 20V5.5l8-2V20M12.5 9h7v11M3 20h18M8 8.5v.01M8 12v.01M8 15.5v.01M16 12.5v.01M16 16v.01"
      {...round}
      {...joined}
    />
  ),
  event: (
    <>
      <rect x="3.5" y="5" width="17" height="15.5" rx="3" {...line} />
      <path d="M3.5 10h17M8 3v4M16 3v4" {...round} />
      <circle cx="12" cy="15" r="1.8" fill="currentColor" />
    </>
  ),
  folder: (
    <path
      d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.8l2 2.2h7.2a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"
      {...joined}
    />
  ),
  doc: (
    <path
      d="M7 3.5h6.8l4.7 4.7v11.3a1.5 1.5 0 0 1-1.5 1.5H7a1.5 1.5 0 0 1-1.5-1.5v-14.5A1.5 1.5 0 0 1 7 3.5zM13.5 3.5v5h5"
      {...joined}
    />
  ),
  // An open book: a PDF in the reader (#504), and the Library of every source (#507).
  book: (
    <path
      d="M12 6.5c-1.8-1.3-4.3-2-7-2v13c2.7 0 5.2.7 7 2 1.8-1.3 4.3-2 7-2v-13c-2.7 0-5.2.7-7 2zM12 6.5v13"
      {...joined}
    />
  ),
  // A page drawn in dashes — a note's outline, not yet a note.
  template: (
    <>
      <path
        d="M7 3.5h6.8l4.7 4.7v11.3a1.5 1.5 0 0 1-1.5 1.5H7a1.5 1.5 0 0 1-1.5-1.5v-14.5A1.5 1.5 0 0 1 7 3.5z"
        {...joined}
        strokeDasharray="2.6 2.2"
      />
      <path d="M9 12.5h6M9 16h4" {...round} />
    </>
  ),
  image: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" {...line} />
      <circle cx="9" cy="9.5" r="1.6" {...line} />
      <path d="M4 17l5.2-4.8 3.6 3.3 2.7-2.4L20 17" {...joined} />
    </>
  ),
  archive: (
    <>
      <rect x="3.5" y="4.5" width="17" height="4.5" rx="1.5" {...joined} />
      <path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9" {...joined} />
      <path d="M10 13h4" {...round} />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="3.2" {...line} />
      <path
        d="M12 2.8v2.6M12 18.6v2.6M2.8 12h2.6M18.6 12h2.6M5.5 5.5l1.8 1.8M16.7 16.7l1.8 1.8M5.5 18.5l1.8-1.8M16.7 7.3l1.8-1.8"
        {...round}
      />
    </>
  ),
  chevron: <path d="M7 9.5l5 5 5-5" {...round} {...joined} strokeWidth={2} />,
  'chevron-left': <path d="M14.5 7l-5 5 5 5" {...round} {...joined} strokeWidth={2} />,
  'chevron-right': <path d="M9.5 7l5 5-5 5" {...round} {...joined} strokeWidth={2} />,
  panel: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="3" {...line} />
      <path d="M9.5 4.5v15" {...line} />
    </>
  ),
  split: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="3" {...line} />
      <path d="M12 4.5v15" {...line} />
    </>
  ),
  close: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" {...round} strokeWidth={1.9} />,
  // A toast's Undo, from design/target/FlowTable.dc.html.
  undo: <path d="M9 7L5 11l4 4M5 11h9a5 5 0 0 1 0 10h-2" {...joined} strokeLinecap="round" />,
  // The page's own glyphs: the nav bar's star and its menu.
  star: (
    <path
      d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"
      {...joined}
    />
  ),
  more: (
    <>
      <circle cx="5.5" cy="12" r="1.7" fill="currentColor" />
      <circle cx="12" cy="12" r="1.7" fill="currentColor" />
      <circle cx="18.5" cy="12" r="1.7" fill="currentColor" />
    </>
  ),
  status: (
    <>
      <circle cx="12" cy="12" r="8" {...line} />
      <path d="M9 12.2l2 2 4-4.3" {...round} {...joined} />
    </>
  ),
  hash: <path d="M5 9h14M5 15h14M10.5 4L8.5 20M15.5 4l-2 16" {...round} />,
  graph: (
    <>
      <circle cx="6" cy="7" r="2.4" {...line} />
      <circle cx="18" cy="6" r="2.4" {...line} />
      <circle cx="12" cy="18" r="2.6" {...line} />
      <path d="M8.3 7.9l8-1.2M7.2 9.1l3.7 6.7M16.9 8.2l-3.7 7.4" {...round} />
    </>
  ),
  link: (
    <path
      d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"
      {...round}
    />
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="4" {...line} />
      <path d="M11 12l8.5-8.5M16.5 6.5l2.5 2.5M14 9l2 2" {...round} />
    </>
  ),
  id: (
    <>
      <rect x="3.5" y="5.5" width="17" height="13" rx="3" {...line} />
      <path d="M7.5 10h5M7.5 14h8" {...round} />
    </>
  ),
  arrow: <path d="M7 17L17 7M8.5 7H17v8.5" {...round} {...joined} strokeWidth={1.9} />,
  forward: <path d="M9.5 7l5 5-5 5" {...round} {...joined} strokeWidth={2} />,
  // Back and Forward in a page's bar, as a browser draws them.
  'arrow-left': <path d="M19 12H5.5M11 6l-6 6 6 6" {...round} {...joined} strokeWidth={1.9} />,
  'arrow-right': <path d="M5 12h13.5M13 6l6 6-6 6" {...round} {...joined} strokeWidth={1.9} />,
  // A number tile's glyphs, from design/target/Main.dc.html.
  bolt: <path d="M13 3L5 13.5h6L10 21l8-10.5h-6z" {...joined} />,
  // The Activity log: a pulse, what has been happening.
  pulse: <path d="M3 12h4l2.5-6 5 12 2.5-6h4" {...round} {...joined} />,
  check: <path d="M6 12.5l4 4 8-8.5" {...round} {...joined} strokeWidth={2.2} />,
  up: <path d="M12 5v14M6.5 10.5L12 5l5.5 5.5" {...round} {...joined} strokeWidth={2} />,
  // The peek's previous and next row, and its "open in new tab" (FlowPeek.dc.html).
  down: <path d="M12 19V5M6.5 13.5L12 19l5.5-5.5" {...round} {...joined} strokeWidth={2} />,
  tab: (
    <>
      <rect x="3.5" y="5.5" width="17" height="14" rx="3" {...line} />
      <path d="M3.5 10h17M10 5.5V10" {...line} />
    </>
  ),
  // The chat's own: Claude's spark, and what a message can do.
  spark: (
    <path
      d="M12 3.5c.6 4.4 2.9 6.9 8 8.5-5.1 1.6-7.4 4.1-8 8.5-.6-4.4-2.9-6.9-8-8.5 5.1-1.6 7.4-4.1 8-8.5z"
      {...joined}
    />
  ),
  copy: (
    <>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2.5" {...line} />
      <path
        d="M15.5 5.5v-.5a1.5 1.5 0 0 0-1.5-1.5H6A2.5 2.5 0 0 0 3.5 6v8A1.5 1.5 0 0 0 5 15.5h.5"
        {...round}
      />
    </>
  ),
  retry: <path d="M19 12a7 7 0 1 1-2.1-5M19 4.5v4h-4" {...round} {...joined} />,
  cloud: (
    <path
      d="M7.5 18.5h9.5a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7 9.6a4.5 4.5 0 0 0 .5 8.9z"
      {...round}
      {...joined}
    />
  ),
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" />,
  history: (
    <>
      <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v3.5H8" {...round} {...joined} />
      <path d="M12 8v4.5l3 2" {...round} {...joined} />
    </>
  ),
  filter: <path d="M4 6.5h16M7 12h10M10 17.5h4" {...round} strokeWidth={1.9} />,
  sort: (
    <path d="M7.5 4.5v15M4.5 16.5l3 3 3-3M16.5 19.5v-15M13.5 7.5l3-3 3 3" {...round} {...joined} />
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8" {...line} />
      <path d="M12 8v4.3l2.8 1.8" {...round} />
    </>
  ),
  tag: (
    <>
      <path d="M3.5 4.5v7.2l8.8 8.8 8.2-8.2-8.8-8.8H4.5a1 1 0 0 0-1 1z" {...joined} />
      <circle cx="8.2" cy="8.2" r="1.4" fill="currentColor" />
    </>
  ),
  // A term: a capital and a small letter — a name and how it is spelt.
  term: (
    <>
      <path d="M3.5 18.5 8 5.5l4.5 13M5.2 13.8h5.6" {...joined} />
      <circle cx="17" cy="15.6" r="2.9" {...line} />
      <path d="M19.9 12.2v6.3" {...round} />
    </>
  ),
  // A skill (#169): a wand, with the glint of what it does.
  skill: (
    <>
      <path d="M4.5 19.5 14 10" {...round} />
      <path d="M12.6 8.6l2.8 2.8" {...round} />
      <path d="M17.5 3.5v3M16 5h3M19.5 11v2M18.5 12h2M9.5 4v2M8.5 5h2" {...round} />
    </>
  ),
  // A highlight (#507): a quotation mark's two commas.
  quote: (
    <>
      <path d="M5 16.5c2.5 0 4-1.6 4-4.2V7.5H4.5v5H8" {...joined} />
      <path d="M15 16.5c2.5 0 4-1.6 4-4.2V7.5h-4.5v5H18" {...joined} />
    </>
  ),
  // Arranging a dashboard: the handle a widget is picked up by.
  grip: (
    <>
      <circle cx="9" cy="6.5" r="1.5" fill="currentColor" />
      <circle cx="15" cy="6.5" r="1.5" fill="currentColor" />
      <circle cx="9" cy="12" r="1.5" fill="currentColor" />
      <circle cx="15" cy="12" r="1.5" fill="currentColor" />
      <circle cx="9" cy="17.5" r="1.5" fill="currentColor" />
      <circle cx="15" cy="17.5" r="1.5" fill="currentColor" />
    </>
  ),
  // The widget kinds a dashboard draws, for the widget editor's picker.
  donut: (
    <>
      <circle cx="12" cy="12" r="7.5" {...line} strokeWidth={3.2} strokeDasharray="30 17.1" />
      <circle cx="12" cy="12" r="7.5" {...line} strokeWidth={1.2} />
    </>
  ),
  trend: (
    <path d="M3.5 17c3-1 4-6.5 7-6.5s3.5 3 6 3 3-5 4-8" {...round} {...joined} strokeWidth={2} />
  ),
  rank: <path d="M4 6.5h16M4 12h11M4 17.5h6" {...round} strokeWidth={2.4} />,
  hero: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="3.5" {...line} />
      <circle cx="15.5" cy="12" r="2.8" {...line} />
      <path d="M6.5 15h4" {...round} />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof GLYPHS;

/**
 * A glyph at a given size. Always decoration: whatever it stands for is said by
 * the text or the accessible name beside it, so it is hidden from a screen
 * reader rather than read out as an unnamed image.
 *
 * Drawn with `memo`: its props are a name and a size, and it was the
 * component drawn most often as the window drew its chrome again (#238).
 */
export const Icon = memo(function Icon({
  name,
  size = 17,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={className === undefined ? 'icon' : `icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      {GLYPHS[name]}
    </svg>
  );
});

/** How each kind of sidebar row is drawn: the system folder wears the gear. */
const SIDEBAR_GLYPHS: Readonly<Record<SidebarIcon, IconName>> = {
  doc: 'doc',
  folder: 'folder',
  system: 'gear',
  archive: 'archive',
  task: 'task',
  person: 'person',
  company: 'company',
  event: 'event',
  table: 'table',
  board: 'board',
  list: 'list',
  grid: 'grid',
  feed: 'feed',
  calendar: 'calendar',
  timeline: 'timeline',
  chart: 'chart',
  graph: 'graph',
  tag: 'tag',
  artifact: 'artifact',
  automation: 'bolt',
  activity: 'pulse',
  template: 'template',
  term: 'term',
  skill: 'skill',
  inbox: 'inbox',
  today: 'sun',
  library: 'book',
  ask: 'spark',
};

export function sidebarGlyph(icon: SidebarIcon): IconName {
  return SIDEBAR_GLYPHS[icon];
}

/** How each kind of property row is drawn. */
const PROPERTY_GLYPHS: Readonly<Record<PropertyIcon, IconName>> = {
  status: 'status',
  number: 'hash',
  date: 'calendar',
  relation: 'link',
  check: 'task',
  link: 'link',
  text: 'id',
  title: 'doc',
  person: 'person',
  duration: 'clock',
  picture: 'image',
};

export function propertyGlyph(icon: PropertyIcon): IconName {
  return PROPERTY_GLYPHS[icon];
}

/** How each glyph a number tile may declare is drawn. */
const WIDGET_GLYPHS: Readonly<Record<WidgetIcon, IconName>> = {
  bolt: 'bolt',
  inbox: 'inbox',
  check: 'check',
  chart: 'chart',
  hash: 'hash',
  star: 'star',
  task: 'task',
};

export function widgetGlyph(icon: WidgetIcon): IconName {
  return WIDGET_GLYPHS[icon];
}

/** How each kind of widget is pictured where one is chosen. */
const WIDGET_KIND_GLYPHS: Readonly<Record<WidgetKind, IconName>> = {
  number: 'hash',
  hero: 'hero',
  list: 'list',
  table: 'table',
  bar: 'chart',
  donut: 'donut',
  line: 'trend',
  rank: 'rank',
  sql: 'table',
  query: 'filter',
};

export function widgetKindGlyph(kind: WidgetKind): IconName {
  return WIDGET_KIND_GLYPHS[kind];
}

/** How each kind of chip on a card is drawn. */
const CHIP_GLYPHS: Readonly<Record<ChipIcon, IconName>> = {
  hash: 'hash',
  person: 'person',
  clock: 'clock',
  date: 'calendar',
  tag: 'tag',
  note: 'link',
};

export function chipGlyph(icon: ChipIcon): IconName {
  return CHIP_GLYPHS[icon];
}
