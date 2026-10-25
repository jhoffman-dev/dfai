import { useEffect, useRef, useState, type RefObject } from 'react';
import { HIGHLIGHT_COLORS } from '@dfai/domain';
import type {
  BookAppearance,
  BookFrameEvents,
  ReaderBook,
  ShownBookSection,
} from './reader-types.ts';

/*
 * The book reader's frame (#505): the chapter on screen, shown again when
 * the chapter changes and let go when the reader goes, and how it looks —
 * the size chosen and the window's own theme, read from its tokens so the
 * marks are the PDF reader's muted pastels.
 */

/** The chapter on screen, once it is: which chapter, and its frame. */
export interface Shown {
  readonly section: number;
  readonly frame: ShownBookSection;
}

/** Shows chapter `section` of `book` in `host`; the one shown before is taken away. */
export function useShownSection({
  book,
  section,
  host,
  appearance,
  events,
  onFailure,
}: {
  book: ReaderBook;
  section: number;
  host: RefObject<HTMLDivElement | null>;
  appearance: BookAppearance;
  events: BookFrameEvents;
  onFailure: (message: string) => void;
}): Shown | null {
  const [shown, setShown] = useState<Shown | null>(null);
  // Read when a chapter is shown, never a reason to show it again.
  const latest = useRef({ appearance, events, onFailure });
  useEffect(() => {
    latest.current = { appearance, events, onFailure };
  });
  useEffect(() => {
    const into = host.current;
    if (into === null) return;
    let live = true;
    let made: ShownBookSection | null = null;
    const forward: BookFrameEvents = {
      onLink: (target) => latest.current.events.onLink(target),
      onSelectionEnd: () => latest.current.events.onSelectionEnd(),
      onKeyDown: (event) => latest.current.events.onKeyDown(event),
      onScroll: () => latest.current.events.onScroll(),
    };
    book.show({ section, host: into, appearance: latest.current.appearance, events: forward }).then(
      (frame) => {
        made = frame;
        if (live) setShown({ section, frame });
        else frame.destroy();
      },
      (error: unknown) => live && latest.current.onFailure(messageOf(error)),
    );
    return () => {
      live = false;
      made?.destroy();
      setShown(null);
    };
  }, [book, section, host]);
  useEffect(() => {
    shown?.frame.setAppearance(appearance);
  }, [shown, appearance]);
  return shown?.section === section ? shown : null;
}

/** Fallbacks for a window whose tokens cannot be read (a test's): the light theme's own. */
const LIGHT: Omit<BookAppearance, 'fontSize'> = {
  scheme: 'light',
  ink: '#18181b',
  page: '#ffffff',
  link: '#6b7bc4',
  marks: Object.fromEntries(
    HIGHLIGHT_COLORS.map((color) => [color, { fill: '#f7e08a', line: '#a67c0c' }]),
  ) as BookAppearance['marks'],
  markInk: '#18181b',
  flash: '#6b7bc4',
  found: '#f9cfac',
  foundCurrent: '#f7a46b',
};

/** How the book looks at `fontSize`, in the window's theme, read again when the theme changes. */
export function useBookAppearance(fontSize: number): BookAppearance {
  const [theme, setTheme] = useState(readTheme);
  useEffect(() => {
    const again = () => setTheme(readTheme());
    const root = document.documentElement;
    const watcher = new MutationObserver(again);
    watcher.observe(root, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    const dark = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
    dark?.addEventListener('change', again);
    return () => {
      watcher.disconnect();
      dark?.removeEventListener('change', again);
    };
  }, []);
  const [shown, setShown] = useState<BookAppearance>(() => ({ ...theme, fontSize }));
  if (shown.fontSize !== fontSize || !sameTheme(shown, theme)) setShown({ ...theme, fontSize });
  return shown;
}

function readTheme(): Omit<BookAppearance, 'fontSize'> {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    scheme: token('--book-scheme', LIGHT.scheme) === 'dark' ? 'dark' : 'light',
    ink: token('--ink', LIGHT.ink),
    page: token('--surface', LIGHT.page),
    link: token('--focus', LIGHT.link),
    marks: Object.fromEntries(
      HIGHLIGHT_COLORS.map((color) => [
        color,
        {
          fill: token(`--mark-${color}`, LIGHT.marks[color].fill),
          line: token(`--mark-${color}-line`, LIGHT.marks[color].line),
        },
      ]),
    ) as BookAppearance['marks'],
    markInk: token('--book-mark-ink', LIGHT.markInk),
    flash: token('--book-flash', LIGHT.flash),
    found: token('--mark-orange', LIGHT.found),
    foundCurrent: token('--book-found-current', LIGHT.foundCurrent),
  };
}

const sameTheme = (a: Omit<BookAppearance, 'fontSize'>, b: Omit<BookAppearance, 'fontSize'>) =>
  JSON.stringify({ ...a, fontSize: 0 }) === JSON.stringify({ ...b, fontSize: 0 });

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
