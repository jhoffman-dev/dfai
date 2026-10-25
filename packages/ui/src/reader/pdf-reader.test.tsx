// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { pdfPageText, type PdfPageText } from '@dfai/domain';
import { AddDocumentDialog } from './add-document-dialog.tsx';
import { HighlightsPanel } from './highlights-panel.tsx';
import { pdfPanelEntries } from './panel-entries.ts';
import { MarkPopover } from './mark-popover.tsx';
import { PdfReader, type PdfReaderProps } from './pdf-reader.tsx';
import type { ReaderDocument, ReaderHighlight } from './reader-types.ts';
import { selectionInPage } from './text-selection.ts';

// jsdom lays nothing out, and a range has no box: the popover sits at the window's corner.
Range.prototype.getBoundingClientRect ??= () => new DOMRect(0, 0, 0, 0);

/** A page of these lines, each a run 0.02 high, one under the other. */
const lines = (...texts: string[]): PdfPageText =>
  pdfPageText(
    texts.map((text, at) => ({
      text,
      box: { x: 0.1, y: 0.1 + at * 0.03, width: text.length * 0.01, height: 0.02 },
      endsLine: at < texts.length - 1,
    })),
  );

const PAGES = [
  lines('The keepers lit the lamps at dusk.', 'A light kept is a promise kept.'),
  lines('Fog came in from the north channel.'),
  lines(),
];

function fakeDocument(pages = PAGES): ReaderDocument & { drawn: number[] } {
  const drawn: number[] = [];
  return {
    pageCount: pages.length,
    drawn,
    pageSize: async () => ({ width: 612, height: 792 }),
    pageText: async (page) => pages[page - 1] as PdfPageText,
    drawPage: ({ page }) => {
      drawn.push(page);
      return { done: Promise.resolve(), cancel: () => {} };
    },
  };
}

const HIGHLIGHT: ReaderHighlight = {
  id: 'k3x9q2',
  quote: 'A light kept',
  comment: 'Said twice.',
  style: { mark: 'highlight', color: 'green' },
  placement: {
    kind: 'words',
    page: 1,
    at: 0,
    rects: [{ x: 0.1, y: 0.13, width: 0.12, height: 0.02 }],
  },
};

function reader(overrides: Partial<PdfReaderProps> = {}) {
  const props: PdfReaderProps = {
    title: 'The Lantern Keepers.pdf',
    folder: 'Library',
    pdf: fakeDocument(),
    firstPageSize: { width: 612, height: 792 },
    outline: [{ title: 'Chapter Two', page: 2, children: [] }],
    highlights: [HIGHLIGHT],
    reveal: null,
    notice: null,
    onOpenNote: vi.fn(),
    onHighlight: vi.fn(async () => true),
    onHighlightArea: vi.fn(async () => true),
    onEditComment: vi.fn(async () => true),
    onRemove: vi.fn(async () => true),
    onSearch: vi.fn(async () => ({ matches: [], more: false })),
    ...overrides,
  };
  const { rerender } = render(<PdfReader {...props} />);
  return Object.assign(props, {
    redraw: (next: Partial<PdfReaderProps>) => rerender(<PdfReader {...props} {...next} />),
  });
}

/** Selects `words` in page `page`'s text layer as a drag would, and lets go. */
async function select(page: number, words: string) {
  const layer = document.querySelector(`[data-pdf-page="${page}"]`) as HTMLElement;
  await waitFor(() =>
    expect(
      within(layer).getByText(
        (_, el) => el?.textContent?.includes(words) === true && el.matches('[data-start]'),
      ),
    ).toBeTruthy(),
  );
  const run = [...layer.querySelectorAll<HTMLElement>('[data-start]')].find((span) =>
    span.textContent?.includes(words),
  ) as HTMLElement;
  const text = run.firstChild as Text;
  const start = (text.textContent ?? '').indexOf(words);
  const range = document.createRange();
  range.setStart(text, start);
  range.setEnd(text, start + words.length);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
  fireEvent.mouseUp(run);
  return { run, start: Number(run.dataset['start']) + start };
}

describe('the PDF reader', () => {
  it('draws only the pages near the screen, with their words to select', async () => {
    const pdf = fakeDocument(Array.from({ length: 500 }, (_, at) => lines(`Page ${at + 1}.`)));
    reader({ pdf });
    expect(await screen.findByText('Page 1.')).toBeTruthy();
    expect(screen.getByText('500 pages')).toBeTruthy();
    expect(pdf.drawn.length).toBeGreaterThan(0);
    expect(pdf.drawn.length).toBeLessThan(8);
  });

  it('offers a highlight for selected words and hands over where they are on their page', async () => {
    const props = reader();
    const { start } = await select(1, 'promise kept');
    const toolbar = screen.getByRole('toolbar', { name: 'Mark the selection' });
    await userEvent.click(within(toolbar).getByRole('button', { name: 'Highlight Blue' }));
    expect(props.onHighlight).toHaveBeenCalledWith({
      style: { mark: 'highlight', color: 'blue' },
      selection: { page: 1, start, end: start + 'promise kept'.length },
    });
    expect(screen.queryByRole('toolbar', { name: 'Mark the selection' })).toBeNull();
  });

  it('offers an underline, and a comment typed with the highlight', async () => {
    const props = reader();
    await select(2, 'north channel');
    await userEvent.click(screen.getByRole('button', { name: 'Underline' }));
    expect(props.onHighlight).toHaveBeenLastCalledWith(
      expect.objectContaining({ style: { mark: 'underline', color: 'yellow' } }),
    );
    await select(2, 'Fog came');
    await userEvent.click(screen.getByRole('button', { name: 'Comment' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Comment' }), 'Spring fog.');
    await userEvent.click(screen.getByRole('button', { name: 'Save comment' }));
    expect(props.onHighlight).toHaveBeenLastCalledWith(
      expect.objectContaining({
        comment: 'Spring fog.',
        style: { mark: 'highlight', color: 'yellow' },
      }),
    );
  });

  it('names each page for assistive technology, so a screen reader can move between them', () => {
    reader();
    expect(screen.getByRole('region', { name: 'Page 1' })).toBeTruthy();
  });

  it('keeps the comment typed in the popover when the note refuses it, and closes once it is taken', async () => {
    const onHighlight = vi.fn(async () => false);
    reader({ onHighlight });
    await select(2, 'Fog came');
    await userEvent.click(screen.getByRole('button', { name: 'Comment' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Comment' }), 'Spring fog.');
    await userEvent.click(screen.getByRole('button', { name: 'Save comment' }));
    expect(screen.getByRole('textbox', { name: 'Comment' })).toHaveProperty('value', 'Spring fog.');
    onHighlight.mockResolvedValueOnce(true);
    await userEvent.click(screen.getByRole('button', { name: 'Save comment' }));
    await waitFor(() =>
      expect(screen.queryByRole('toolbar', { name: 'Mark the selection' })).toBeNull(),
    );
  });

  it('keeps the comment edited in the panel when the note refuses it', async () => {
    reader({ onEditComment: vi.fn(async () => false) });
    await userEvent.click(screen.getByRole('button', { name: /comment/i }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Comment' }), ' More.');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('textbox', { name: 'Comment' })).toBeTruthy();
  });

  it('offers nothing to mark when the PDF has no literature note', async () => {
    reader({ onOpenNote: null });
    await select(1, 'promise kept');
    expect(screen.queryByRole('toolbar', { name: 'Mark the selection' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open note' })).toBeNull();
  });

  it('draws each highlight on its page in its colour, and an underline as one', async () => {
    reader({
      highlights: [
        HIGHLIGHT,
        { ...HIGHLIGHT, id: 'under1', style: { mark: 'underline', color: 'pink' } },
        {
          ...HIGHLIGHT,
          id: 'moved1',
          placement: { ...HIGHLIGHT.placement, kind: 'boxes' } as ReaderHighlight['placement'],
        },
      ],
    });
    await screen.findByText('The keepers lit the lamps at dusk.');
    const marks = document.querySelectorAll('[data-pdf-page="1"] .pdf-mark');
    expect([...marks].map((mark) => mark.className)).toEqual([
      'pdf-mark pdf-mark--highlight pdf-mark--green',
      'pdf-mark pdf-mark--underline pdf-mark--pink',
      'pdf-mark pdf-mark--highlight pdf-mark--green pdf-mark--approximate',
    ]);
    expect((marks[0] as HTMLElement).style.top).toBe('13%');
  });

  it('flashes the highlight it is asked to reveal once it is placed, and again only on a new ask', async () => {
    const entry = () => document.querySelector('[data-highlight-entry="k3x9q2"]')?.className ?? '';
    const props = reader({ highlights: [], reveal: { id: 'k3x9q2', key: 1 } });
    expect(entry()).toBe('');
    props.redraw({ highlights: [HIGHLIGHT], reveal: { id: 'k3x9q2', key: 1 } });
    await waitFor(() => expect(entry()).toContain('pdf-entry--flash'));
    expect(document.querySelector('.pdf-mark--flash')).not.toBeNull();
  });

  it('offers an area highlight for a box dragged on a page with no words', async () => {
    const props = reader();
    await waitFor(() =>
      expect(document.querySelector('[data-pdf-page="3"] .pdf-area')).not.toBeNull(),
    );
    const area = document.querySelector('[data-pdf-page="3"] .pdf-area') as HTMLElement;
    // jsdom lays the area out as 280 by 800 from the window's corner (vitest.setup.ts).
    fireEvent.pointerDown(area, { clientX: 28, clientY: 80, pointerId: 1 });
    fireEvent.pointerMove(area, { clientX: 140, clientY: 400, pointerId: 1 });
    fireEvent.pointerUp(area, { clientX: 140, clientY: 400, pointerId: 1 });
    const toolbar = screen.getByRole('toolbar', { name: 'Mark the selection' });
    expect(within(toolbar).queryByRole('button', { name: 'Underline' })).toBeNull();
    await userEvent.click(within(toolbar).getByRole('button', { name: 'Highlight Orange' }));
    expect(props.onHighlightArea).toHaveBeenCalledWith({
      style: { mark: 'highlight', color: 'orange' },
      page: 3,
      box: { x: 0.1, y: 0.1, width: 0.4, height: 0.4 },
    });
  });

  it('searches the document and says how many it found', async () => {
    const match = {
      page: 2,
      start: 0,
      end: 3,
      rects: [{ x: 0.1, y: 0.1, width: 0.03, height: 0.02 }],
    };
    const onSearch = vi.fn(async () => ({
      matches: [match, { ...match, start: 4, end: 7 }],
      more: false,
    }));
    reader({ onSearch });
    await userEvent.click(screen.getByRole('button', { name: 'Find' }));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Find in document' }), 'Fog');
    expect(await screen.findByText('1 of 2')).toBeTruthy();
    expect(onSearch).toHaveBeenLastCalledWith('Fog');
    await userEvent.click(screen.getByRole('button', { name: 'Next match' }));
    expect(screen.getByText('2 of 2')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Next match' }));
    expect(screen.getByText('1 of 2')).toBeTruthy();
  });

  it('zooms by steps and says the zoom', async () => {
    reader();
    expect(screen.getByText('100%')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByText('110%')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    await userEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(screen.getByText('90%')).toBeTruthy();
  });

  it('lists the outline, and the notice over the pages', async () => {
    reader({ notice: 'The note changed meanwhile.' });
    expect(screen.getByRole('alert').textContent).toBe('The note changed meanwhile.');
    await userEvent.click(screen.getByRole('button', { name: 'Outline' }));
    expect(screen.getByRole('button', { name: /Chapter Two/ })).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: 'Pages' }));
    expect(screen.getAllByRole('button', { name: /Go to page/ }).length).toBeGreaterThan(0);
  });
});

describe('a turned run in the text layer', () => {
  it('starts at its first letter and turns the way it reads, so a drag along it picks part of it', async () => {
    const down = pdfPageText([
      {
        text: 'Down the margin',
        box: { x: 0.5, y: 0.1, width: 0.02, height: 0.4 },
        endsLine: false,
        direction: {
          origin: { x: 0.5, y: 0.1 },
          advance: { x: 0, y: 0.4 },
          rise: { x: 0.02, y: 0 },
        },
      },
    ]);
    reader({ pdf: fakeDocument([down]), highlights: [] });
    const span = (await screen.findByText('Down the margin')) as HTMLElement;
    // 612 x 792 at the first zoom: its letters' top is 0.02 of the width right of its start.
    const zoomed = Number.parseFloat(span.style.fontSize) / (0.02 * 612);
    expect(Number.parseFloat(span.style.left)).toBeCloseTo(0.52 * 612 * zoomed, 3);
    expect(Number.parseFloat(span.style.top)).toBeCloseTo(0.1 * 792 * zoomed, 3);
    // Turned a quarter, then stretched along the way it reads.
    expect(span.style.transform.startsWith(`rotate(${Math.PI / 2}rad) scaleX(`)).toBe(true);
  });

  it('leaves a run that reads across the page untouched', async () => {
    reader();
    const span = (await screen.findByText('A light kept is a promise kept.')) as HTMLElement;
    expect(span.dataset['turn']).toBeUndefined();
    expect(span.style.transform).toMatch(/^scaleX\([\d.]+\)$/);
  });
});

describe('the highlights panel', () => {
  const panel = (highlights: ReaderHighlight[]) => {
    const props = {
      entries: pdfPanelEntries(highlights),
      emptyHint: 'Select words on a page to highlight them.',
      flashing: null,
      onShow: vi.fn(),
      onEditComment: vi.fn(async () => true),
      onRemove: vi.fn(async () => true),
    };
    render(<HighlightsPanel {...props} />);
    return props;
  };

  it('lists each highlight with its page and comment, and shows one when clicked', async () => {
    const props = panel([HIGHLIGHT]);
    expect(screen.getByText('p. 1')).toBeTruthy();
    expect(screen.getByText('Said twice.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /A light kept/ }));
    expect(props.onShow).toHaveBeenCalledWith('k3x9q2');
  });

  it('edits a comment and saves what was typed', async () => {
    const props = panel([HIGHLIGHT]);
    await userEvent.click(screen.getByRole('button', { name: 'Edit comment' }));
    const field = screen.getByRole('textbox', { name: 'Comment' });
    await userEvent.clear(field);
    await userEvent.type(field, 'Said three times.');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(props.onEditComment).toHaveBeenCalledWith({
      id: 'k3x9q2',
      comment: 'Said three times.',
    });
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Comment' })).toBeNull());
  });

  it('deletes only after asking, and keeps it when the person keeps it', async () => {
    const props = panel([HIGHLIGHT]);
    await userEvent.click(screen.getByRole('button', { name: 'Delete…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(props.onRemove).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Delete…' }));
    const asking = screen.getByRole('group', { name: 'Delete this highlight?' });
    await userEvent.click(within(asking).getByRole('button', { name: 'Delete' }));
    expect(props.onRemove).toHaveBeenCalledWith('k3x9q2');
  });

  it('says when a highlight could not be found exactly, and an area for what it is', () => {
    panel([
      { ...HIGHLIGHT, id: 'a', placement: { kind: 'lost' } },
      {
        ...HIGHLIGHT,
        id: 'b',
        placement: { ...HIGHLIGHT.placement, kind: 'boxes' } as ReaderHighlight['placement'],
      },
      { ...HIGHLIGHT, id: 'c', quote: '', placement: { kind: 'area', page: 4, rects: [] } },
    ]);
    expect(screen.getByText("Couldn't find the exact spot in this file.")).toBeTruthy();
    expect(screen.getByText(/shown where it was when it was made/)).toBeTruthy();
    expect(screen.getByText('Area of the page')).toBeTruthy();
    expect(screen.getByText('No page')).toBeTruthy();
    expect((screen.getByText('No page').closest('button') as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('asks the person to select words when there are none', () => {
    panel([]);
    expect(screen.getByText('Select words on a page to highlight them.')).toBeTruthy();
  });
});

describe('the mark popover', () => {
  it('closes on Escape and saves a comment with ⌘↵', async () => {
    const onMark = vi.fn();
    const onDismiss = vi.fn();
    render(
      <MarkPopover at={{ left: 0, top: 0 }} canUnderline onMark={onMark} onDismiss={onDismiss} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Comment' }));
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Comment' }),
      'Note{Meta>}{Enter}{/Meta}',
    );
    expect(onMark).toHaveBeenCalledWith({
      style: { mark: 'highlight', color: 'yellow' },
      comment: 'Note',
    });
    fireEvent.keyDown(screen.getByRole('toolbar'), { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalled();
  });
});

describe('a selection read back from the text layer', () => {
  const layer = () => {
    document.body.innerHTML =
      '<div data-pdf-page="2" data-text-length="21"><div class="pdf-text">' +
      '<span data-start="0" data-end="9">Fog came </span><span data-start="9" data-end="20">in at dusk.</span>' +
      '</div></div><div data-pdf-page="3" data-text-length="5"><span data-start="0" data-end="5">Later</span></div>';
    return [...document.querySelectorAll('span')];
  };
  const selectBetween = (start: [Node, number], end: [Node, number]) => {
    const range = document.createRange();
    range.setStart(...start);
    range.setEnd(...end);
    const selection = window.getSelection() as Selection;
    selection.removeAllRanges();
    selection.addRange(range);
    return selection;
  };

  it('is its page and offsets, across runs', () => {
    const [first, second] = layer();
    const selection = selectBetween([first!.firstChild!, 4], [second!.firstChild!, 2]);
    expect(selectionInPage(selection)).toEqual({ page: 2, start: 4, end: 11 });
  });

  it("is cut at its first page's end when it runs onto the next", () => {
    const [first, , later] = layer();
    const selection = selectBetween([first!.firstChild!, 4], [later!.firstChild!, 3]);
    expect(selectionInPage(selection)).toEqual({ page: 2, start: 4, end: 21 });
  });

  it('reads a point between runs as the next run’s start', () => {
    const [first] = layer();
    const text = first!.parentElement as HTMLElement;
    const selection = selectBetween([text, 1], [text, 2]);
    expect(selectionInPage(selection)).toEqual({ page: 2, start: 9, end: 20 });
  });

  it('is nothing for an empty selection, or one outside every page', () => {
    layer();
    expect(selectionInPage(null)).toBeNull();
    const outside = document.createElement('p');
    outside.textContent = 'elsewhere';
    document.body.append(outside);
    expect(
      selectionInPage(selectBetween([outside.firstChild!, 0], [outside.firstChild!, 4])),
    ).toBeNull();
    const [first] = layer();
    expect(
      selectionInPage(selectBetween([first!.firstChild!, 2], [first!.firstChild!, 2])),
    ).toBeNull();
  });
});

describe('the Add PDF dialog', () => {
  it('hands over PDFs picked or dropped, and says why one was refused', async () => {
    const onFiles = vi.fn();
    render(
      <AddDocumentDialog
        kind="pdf"
        folder="Library"
        adding={false}
        error="“notes.txt” is not a PDF."
        onFiles={onFiles}
        onClose={() => {}}
      />,
    );
    const pdf = new File(['%PDF-1.4'], 'lantern.pdf', { type: 'application/pdf' });
    await userEvent.upload(screen.getByLabelText('Choose PDF'), pdf);
    expect(onFiles).toHaveBeenCalledWith([pdf]);
    expect(screen.getByRole('alert').textContent).toBe('“notes.txt” is not a PDF.');
    expect(screen.getByText(/A copy goes into Library/)).toBeTruthy();
    fireEvent.drop(screen.getByRole('group', { name: 'Drop PDFs here' }), {
      dataTransfer: { types: ['Files'], files: [pdf] },
    });
    expect(onFiles).toHaveBeenCalledTimes(2);
  });
});
