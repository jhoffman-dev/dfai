// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BookRange } from '@dfai/domain';
import { AddDocumentDialog } from './add-document-dialog.tsx';
import { BookReader, type BookReaderProps } from './book-reader.tsx';
import type {
  BookAppearance,
  BookFrameEvents,
  BookMark,
  ReaderBook,
  ReaderBookHighlight,
  ShownBookSection,
} from './reader-types.ts';

/*
 * The EPUB reader (#505), drawn with a book that shows each chapter as a
 * plain element in place of foliate-js's frame: what it is asked to show and
 * draw, the chapter turns and the contents, the marks a selection offers and
 * what they write, find in the book, the text size, and a highlight asked
 * for from outside.
 */

const CHAPTERS = [
  'A Hare one day ridiculed the Tortoise.',
  'When the winter came, the Grasshopper had no food.',
];

interface FakeFrame extends ShownBookSection {
  readonly section: number;
  painted: { marks: readonly BookMark[]; flashing: string | null }[];
  found: { found: readonly { start: number; end: number }[]; current: number | null }[];
  scrolledTo: (number | string | null)[];
  looks: BookAppearance[];
  picked: { start: number; end: number } | null;
  destroyed: boolean;
}

function fakeBook(): ReaderBook & { frames: FakeFrame[]; events: BookFrameEvents[] } {
  const frames: FakeFrame[] = [];
  const events: BookFrameEvents[] = [];
  return {
    frames,
    events,
    sectionCount: CHAPTERS.length,
    contents: [
      { title: 'The Hare and the Tortoise', section: 0, children: [] },
      { title: 'The Ant and the Grasshopper', section: 1, children: [] },
    ],
    sectionOfPath: (path) => (path === 'OEBPS/ants.xhtml' ? 1 : null),
    show: async ({ section, host, appearance, events: on }) => {
      const shown = document.createElement('div');
      shown.dataset['testid'] = 'chapter';
      shown.textContent = CHAPTERS[section] ?? '';
      host.append(shown);
      events.push(on);
      const frame: FakeFrame = {
        section,
        painted: [],
        found: [],
        scrolledTo: [],
        looks: [appearance],
        picked: null,
        destroyed: false,
        selection: () =>
          frame.picked === null ? null : { ...frame.picked, rect: new DOMRect(40, 60, 30, 10) },
        clearSelection: () => {
          frame.picked = null;
        },
        paint: (marks, flashing) => frame.painted.push({ marks, flashing }),
        paintFound: (found, current) => frame.found.push({ found, current }),
        scrollToOffset: (offset) => frame.scrolledTo.push(offset),
        scrollToFragment: (fragment) => frame.scrolledTo.push(fragment),
        setAppearance: (look) => frame.looks.push(look),
        destroy: () => {
          frame.destroyed = true;
          shown.remove();
        },
      };
      frames.push(frame);
      return frame;
    },
  };
}

const placed = (
  id: string,
  range: BookRange,
  color: 'green' | 'blue' = 'green',
): ReaderBookHighlight => ({
  id,
  quote: CHAPTERS[range.section]?.slice(range.start, range.end) ?? '',
  comment: '',
  style: { mark: 'highlight', color },
  placement: { kind: 'cfi', range },
});

const HARE = placed('hare01', { section: 0, start: 2, end: 6 });
const WINTER = placed('wint01', { section: 1, start: 9, end: 15 }, 'blue');

function reader(overrides: Partial<BookReaderProps> = {}) {
  const book = fakeBook();
  const props: BookReaderProps = {
    title: 'Fables of Brightwater',
    folder: 'Library',
    book,
    highlights: [HARE, WINTER],
    reveal: null,
    notice: null,
    onOpenNote: vi.fn(),
    onHighlight: vi.fn(async () => true),
    onEditComment: vi.fn(async () => true),
    onRemove: vi.fn(async () => true),
    onSearch: vi.fn(async () => ({ matches: [], more: false })),
    ...overrides,
  };
  const { rerender } = render(<BookReader {...props} />);
  return Object.assign(props, {
    book,
    redraw: (next: Partial<BookReaderProps>) => rerender(<BookReader {...props} {...next} />),
  });
}

const lastFrame = (book: { frames: FakeFrame[] }) => book.frames.at(-1) as FakeFrame;

/** The chapter on screen once the reader has it: it draws in it as soon as it does. */
async function shownChapter(book: { frames: FakeFrame[] }): Promise<FakeFrame> {
  await waitFor(() => expect(book.frames.at(-1)?.painted.length ?? 0).toBeGreaterThan(0));
  return lastFrame(book);
}

describe('the book reader', () => {
  it("shows the first chapter, drawing that chapter's highlights only", async () => {
    const { book } = reader();
    expect(await screen.findByText(CHAPTERS[0] as string)).toBeTruthy();
    await waitFor(() =>
      expect(lastFrame(book).painted.at(-1)?.marks).toEqual([
        { id: 'hare01', start: 2, end: 6, style: HARE.style },
      ]),
    );
    expect(screen.getByText('1 of 2')).toBeTruthy();
    expect(screen.getAllByText('The Hare and the Tortoise').length).toBeGreaterThan(0);
  });

  it('turns to the next and previous chapter, letting the one before go', async () => {
    const { book } = reader();
    await screen.findByText(CHAPTERS[0] as string);
    await userEvent.click(screen.getByRole('button', { name: 'Next chapter' }));
    expect(await screen.findByText(CHAPTERS[1] as string)).toBeTruthy();
    expect(book.frames[0]?.destroyed).toBe(true);
    expect(screen.getByText('2 of 2')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next chapter' })).toHaveProperty('disabled', true);
    await waitFor(() =>
      expect(
        lastFrame(book)
          .painted.at(-1)
          ?.marks.map((mark) => mark.id),
      ).toEqual(['wint01']),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Previous chapter' }));
    expect(await screen.findByText(CHAPTERS[0] as string)).toBeTruthy();
  });

  it('goes to a chapter from the contents', async () => {
    reader();
    await userEvent.click(screen.getByRole('button', { name: 'Contents' }));
    const contents = screen.getByRole('navigation', { name: 'Contents' });
    await userEvent.click(
      within(contents).getByRole('button', { name: 'The Ant and the Grasshopper' }),
    );
    expect(await screen.findByText(CHAPTERS[1] as string)).toBeTruthy();
  });

  it('follows a link inside the book to its chapter and the place it names', async () => {
    const { book } = reader();
    await screen.findByText(CHAPTERS[0] as string);
    act(() => book.events.at(-1)?.onLink({ path: 'OEBPS/ants.xhtml', fragment: 'winter' }));
    expect(await screen.findByText(CHAPTERS[1] as string)).toBeTruthy();
    await waitFor(() => expect(lastFrame(book).scrolledTo).toEqual(['winter']));
    // A link to a file that is no chapter goes nowhere.
    act(() => book.events.at(-1)?.onLink({ path: 'OEBPS/cover.jpg', fragment: null }));
    expect(screen.getByText('2 of 2')).toBeTruthy();
  });

  it('offers the marks for words selected in the chapter, and writes the one pressed', async () => {
    const props = reader();
    const frame = await shownChapter(props.book);
    frame.picked = { start: 7, end: 10 };
    act(() => props.book.events.at(-1)?.onSelectionEnd());
    const toolbar = await screen.findByRole('toolbar', { name: 'Mark the selection' });
    await userEvent.click(within(toolbar).getByRole('button', { name: 'Underline' }));
    expect(props.onHighlight).toHaveBeenCalledWith({
      style: { mark: 'underline', color: 'yellow' },
      selection: { section: 0, start: 7, end: 10 },
    });
    expect(screen.queryByRole('toolbar', { name: 'Mark the selection' })).toBeNull();
    expect(frame.picked).toBeNull();
  });

  it('keeps a comment the note refused, to save again', async () => {
    const props = reader({ onHighlight: vi.fn(async () => false) });
    (await shownChapter(props.book)).picked = { start: 0, end: 6 };
    act(() => props.book.events.at(-1)?.onSelectionEnd());
    const toolbar = await screen.findByRole('toolbar', { name: 'Mark the selection' });
    await userEvent.click(within(toolbar).getByRole('button', { name: 'Comment' }));
    await userEvent.type(within(toolbar).getByRole('textbox', { name: 'Comment' }), 'Pride.');
    await userEvent.click(within(toolbar).getByRole('button', { name: 'Save comment' }));
    expect(props.onHighlight).toHaveBeenCalledWith(expect.objectContaining({ comment: 'Pride.' }));
    expect(screen.getByRole('toolbar', { name: 'Mark the selection' })).toBeTruthy();
  });

  it('offers no marks for a book with no literature note, and says what to do', async () => {
    const props = reader({ onOpenNote: null, notice: 'This book has no literature note.' });
    (await shownChapter(props.book)).picked = { start: 0, end: 6 };
    act(() => props.book.events.at(-1)?.onSelectionEnd());
    expect(screen.queryByRole('toolbar', { name: 'Mark the selection' })).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('This book has no literature note.');
    expect(screen.queryByRole('button', { name: 'Open note' })).toBeNull();
  });

  it('brings a highlight in another chapter into view from the panel, lit', async () => {
    const { book } = reader();
    await screen.findByText(CHAPTERS[0] as string);
    const panel = screen.getByRole('complementary', { name: 'Highlights' });
    await userEvent.click(within(panel).getByRole('button', { name: /Grasshop/ }));
    expect(await screen.findByText(CHAPTERS[1] as string)).toBeTruthy();
    await waitFor(() => expect(lastFrame(book).scrolledTo).toEqual([9]));
    await waitFor(() => expect(lastFrame(book).painted.at(-1)?.flashing).toBe('wint01'));
  });

  it('brings the highlight asked for into view once it is placed, once per ask', async () => {
    const props = reader({ highlights: [], reveal: { id: 'wint01', key: 1 } });
    await screen.findByText(CHAPTERS[0] as string);
    props.redraw({ highlights: [HARE, WINTER], reveal: { id: 'wint01', key: 1 } });
    expect(await screen.findByText(CHAPTERS[1] as string)).toBeTruthy();
    await waitFor(() => expect(lastFrame(props.book).scrolledTo).toEqual([9]));
  });

  it('lists a highlight it could not find as not found, and offers no way to show it', () => {
    reader({ highlights: [{ ...WINTER, placement: { kind: 'lost' } }] });
    const panel = screen.getByRole('complementary', { name: 'Highlights' });
    expect(within(panel).getByText("Couldn't find this passage in this book.")).toBeTruthy();
    expect(within(panel).getByRole('button', { name: /Not found/ })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('finds in the book, going to the chapter of the match and drawing the matches there', async () => {
    const matches = [
      { section: 1, start: 30, end: 41 },
      { section: 1, start: 0, end: 4 },
    ];
    const props = reader({ onSearch: vi.fn(async () => ({ matches, more: false })) });
    await screen.findByText(CHAPTERS[0] as string);
    await userEvent.click(screen.getByRole('button', { name: 'Find' }));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Find in document' }), 'grass');
    expect(await screen.findByText('1 of 2')).toBeTruthy();
    expect(await screen.findByText(CHAPTERS[1] as string)).toBeTruthy();
    await waitFor(() =>
      expect(lastFrame(props.book).found.at(-1)).toEqual({ found: matches, current: 0 }),
    );
    expect(lastFrame(props.book).scrolledTo).toContain(30);
  });

  it('opens find on ⌘F pressed in the chapter', async () => {
    const { book } = reader();
    await screen.findByText(CHAPTERS[0] as string);
    const press = new KeyboardEvent('keydown', { key: 'f', metaKey: true, cancelable: true });
    act(() => book.events.at(-1)?.onKeyDown(press));
    expect(press.defaultPrevented).toBe(true);
    expect(await screen.findByRole('searchbox', { name: 'Find in document' })).toBeTruthy();
  });

  it('makes the text larger and smaller in steps, and tells the frame', async () => {
    const { book } = reader();
    await screen.findByText(CHAPTERS[0] as string);
    await userEvent.click(screen.getByRole('button', { name: 'Larger text' }));
    expect(screen.getByText('110%')).toBeTruthy();
    await waitFor(() => expect(lastFrame(book).looks.at(-1)?.fontSize).toBe(110));
    await userEvent.click(screen.getByRole('button', { name: 'Smaller text' }));
    await userEvent.click(screen.getByRole('button', { name: 'Smaller text' }));
    expect(screen.getByText('90%')).toBeTruthy();
  });

  it('says a chapter that could not be shown', async () => {
    const book = {
      ...fakeBook(),
      show: async () => Promise.reject(new Error('its file is missing')),
    };
    reader({ book });
    expect((await screen.findByRole('alert')).textContent).toBe('its file is missing');
  });
});

describe('the Add EPUB dialog', () => {
  it('hands over EPUBs picked or dropped, and says why one was refused', async () => {
    const onFiles = vi.fn();
    render(
      <AddDocumentDialog
        kind="epub"
        folder="Library"
        adding={false}
        error="“locked.epub” is protected with DRM, so DFAI can't open it."
        onFiles={onFiles}
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole('dialog', { name: 'Add EPUB to Library' })).toBeTruthy();
    const epub = new File(['PK'], 'fables.epub', { type: 'application/epub+zip' });
    const field = screen.getByLabelText('Choose EPUB') as HTMLInputElement;
    expect(field.accept).toBe('.epub,application/epub+zip');
    await userEvent.upload(field, epub);
    expect(onFiles).toHaveBeenCalledWith([epub]);
    expect(screen.getByRole('alert').textContent).toContain('protected with DRM');
    fireEvent.drop(screen.getByRole('group', { name: 'Drop EPUBs here' }), {
      dataTransfer: { types: ['Files'], files: [epub] },
    });
    expect(onFiles).toHaveBeenCalledTimes(2);
  });
});
