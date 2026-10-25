// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SearchPalette } from './search-palette.tsx';

const hits = [
  { path: 'a.md', title: 'Weekly review', snippet: 'the <<weekly>> plan' },
  { path: 'b.md', title: 'Recipes', snippet: 'sourdough' },
];

const props = {
  query: '',
  hits,
  selected: 0,
  onQuery: () => {},
  onMove: () => {},
  onPick: () => {},
  onClose: () => {},
};

/** The palette as the app mounts it: something else has focus until it opens. */
function Opener({ open }: { open: boolean }) {
  return (
    <>
      <button type="button">Opened me</button>
      {open ? <SearchPalette {...props} /> : null}
    </>
  );
}

describe('SearchPalette', () => {
  it('focuses the input so typing starts a search straight away', async () => {
    render(<SearchPalette {...props} />);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('searchbox', { name: 'Search the vault' }),
      ),
    );
  });

  it('lists a result per hit', () => {
    render(<SearchPalette {...props} />);
    expect(screen.getAllByRole('option')).toHaveLength(2);
  });

  it('marks the words that matched', () => {
    render(<SearchPalette {...props} />);
    expect(screen.getByText('weekly').tagName).toBe('MARK');
  });

  it('marks the selected result for assistive technology', () => {
    render(<SearchPalette {...props} selected={1} />);
    const selected = screen
      .getAllByRole('option')
      .filter((option) => option.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0]?.textContent).toContain('Recipes');
  });

  it('reports what is typed', async () => {
    const onQuery = vi.fn();
    render(<SearchPalette {...props} onQuery={onQuery} />);
    await userEvent.type(screen.getByRole('searchbox'), 'we');
    expect(onQuery).toHaveBeenCalled();
  });

  it.each([
    ['ArrowDown', 1],
    ['ArrowUp', -1],
  ])('moves the selection on %s', async (key, delta) => {
    const onMove = vi.fn();
    render(<SearchPalette {...props} onMove={onMove} />);
    await userEvent.type(screen.getByRole('searchbox'), `{${key}}`);
    expect(onMove).toHaveBeenCalledWith(delta);
  });

  it('opens the selected result on Enter', async () => {
    const onPick = vi.fn();
    render(<SearchPalette {...props} selected={1} onPick={onPick} />);
    await userEvent.type(screen.getByRole('searchbox'), '{Enter}');
    expect(onPick).toHaveBeenCalledWith('b.md');
  });

  it('opens a result that is clicked', async () => {
    const onPick = vi.fn();
    render(<SearchPalette {...props} onPick={onPick} />);
    await userEvent.click(screen.getByRole('option', { name: /Recipes/ }));
    expect(onPick).toHaveBeenCalledWith('b.md');
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    render(<SearchPalette {...props} onClose={onClose} />);
    await userEvent.type(screen.getByRole('searchbox'), '{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes when the backdrop is clicked', async () => {
    const onClose = vi.fn();
    // The palette is portalled to the body, so the backdrop is not under the
    // container the test rendered into.
    const { baseElement } = render(<SearchPalette {...props} onClose={onClose} />);
    const backdrop = baseElement.querySelector('.palette__backdrop');
    expect(backdrop).not.toBeNull();
    if (backdrop !== null) await userEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('gives focus back to whatever had it before, once it closes', async () => {
    const view = render(<Opener open={false} />);
    const opener = screen.getByRole('button', { name: 'Opened me' });
    opener.focus();

    view.rerender(<Opener open />);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('searchbox')));

    view.rerender(<Opener open={false} />);
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('locks the page behind it, and lets go when it closes', async () => {
    expect(document.body.style.overflowY).toBe('');

    const view = render(<SearchPalette {...props} />);
    await waitFor(() => expect(document.body.style.overflowY).toBe('hidden'));

    view.unmount();
    await waitFor(() => expect(document.body.style.overflowY).toBe(''));
  });

  it('stays open when the palette itself is clicked', async () => {
    const onClose = vi.fn();
    render(<SearchPalette {...props} onClose={onClose} />);
    await userEvent.click(screen.getByRole('dialog', { name: 'Search notes' }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('says where each result lives the way the sidebar does, never as .atlas', () => {
    render(
      <SearchPalette
        {...props}
        hits={[
          { path: '.atlas/views/Board.md', title: 'Board', snippet: '' },
          { path: 'tasks/P1.md', title: 'P1', snippet: 'a <<task>>' },
        ]}
      />,
    );
    const [view, note] = screen.getAllByRole('option');
    expect(view?.textContent).toContain('Views');
    expect(view?.textContent).not.toContain('.atlas');
    expect(note?.textContent).toContain('tasks');
  });

  it('names a result by its title and place, not by the keys drawn beside it', () => {
    render(<SearchPalette {...props} />);
    const chosen = screen.getByRole('option', { name: /^Weekly review/ });
    expect(chosen.getAttribute('aria-selected')).toBe('true');
    expect(chosen.textContent).toContain('↵');
    expect(screen.queryByRole('option', { name: /↵/ })).toBeNull();
  });

  it('draws every result as a row, the chosen one wearing the selected fill', () => {
    render(<SearchPalette {...props} selected={1} />);
    const rows = screen.getAllByRole('option');
    expect(rows.every((row) => row.classList.contains('palette__hit'))).toBe(true);
    expect(rows.map((row) => row.classList.contains('palette__hit--on'))).toEqual([false, true]);
  });

  it('hides the kind icon on a hit as on a command: the place says what it is', () => {
    render(<SearchPalette {...props} commands={[{ id: 'new-view', label: 'New view' }]} />);
    const kinds = document.querySelectorAll('.palette__kind');
    expect(kinds.length).toBe(3);
    for (const kind of kinds) expect(kind.getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps the keys along its foot out of what a screen reader is read', () => {
    const { baseElement } = render(<SearchPalette {...props} />);
    const hints = baseElement.querySelector('.key-hints');
    expect(hints?.getAttribute('aria-hidden')).toBe('true');
    expect(hints?.textContent).toContain('to open');
    // The field's esc and the chosen row's ↵ are hidden the same way.
    for (const key of baseElement.querySelectorAll('.key')) {
      expect(key.closest('[aria-hidden="true"]')).not.toBeNull();
    }
  });

  it('says so when a search matches nothing', () => {
    render(<SearchPalette {...props} query="zzz" hits={[]} />);
    expect(screen.getByText('Nothing matches.')).toBeDefined();
  });

  it('shows no message before anything has been typed', () => {
    render(<SearchPalette {...props} query="" hits={[]} />);
    expect(screen.queryByText('Nothing matches.')).toBeNull();
  });
});

describe('SearchPalette and archived notes', () => {
  it('offers no Include archived switch unless it is given one', () => {
    render(<SearchPalette {...props} />);
    expect(screen.queryByRole('switch', { name: 'Include archived' })).toBeNull();
  });

  it('switches Include archived, showing which it is', async () => {
    const onChange = vi.fn();
    render(<SearchPalette {...props} archived={{ included: false, onChange }} />);
    const toggle = screen.getByRole('switch', { name: 'Include archived' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await userEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('says an archived hit is in the Archive, not the folder it keeps there', () => {
    render(
      <SearchPalette
        {...props}
        hits={[{ path: 'Archive/Projects/Old.md', title: 'Old', snippet: '' }]}
      />,
    );
    expect(screen.getByText('Archive')).toBeTruthy();
    expect(screen.queryByText('Projects')).toBeNull();
  });
});

describe('SearchPalette by meaning (P32-02)', () => {
  const meaning = (
    overrides: Partial<Parameters<typeof SearchPalette>[0]['meaning'] & object> = {},
  ) => ({
    on: true,
    onChange: () => {},
    progress: null,
    problem: null,
    ...overrides,
  });

  it('offers no By meaning switch unless it is given one', () => {
    render(<SearchPalette {...props} archived={{ included: false, onChange: () => {} }} />);
    expect(screen.getByRole('switch', { name: 'Include archived' })).toBeTruthy();
    expect(screen.queryByRole('switch', { name: 'By meaning' })).toBeNull();
  });

  it('switches By meaning, showing which it is', async () => {
    const onChange = vi.fn();
    render(<SearchPalette {...props} meaning={meaning({ on: false, onChange })} />);
    const toggle = screen.getByRole('switch', { name: 'By meaning' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await userEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('says the cache of meanings is still being built, and stops saying so once it is', () => {
    const { rerender } = render(
      <SearchPalette {...props} meaning={meaning({ progress: { done: 12, total: 40 } })} />,
    );
    expect(screen.getByRole('status').textContent).toBe(
      'Still reading notes for meaning: 12 of 40.',
    );
    rerender(<SearchPalette {...props} meaning={meaning({ progress: { done: 40, total: 40 } })} />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('says why the cache of meanings stopped being built, and how far it had got', () => {
    render(
      <SearchPalette
        {...props}
        meaning={meaning({ progress: { done: 12, total: 40, failure: 'no network' } })}
      />,
    );
    expect(
      screen.getByText('Stopped reading notes for meaning (12 of 40): no network'),
    ).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('does not draw a row, or the switches, again for a key typed or a handler made anew', () => {
    let titleReads = 0;
    const counted = {
      path: 'a.md',
      snippet: 'sourdough',
      get title() {
        titleReads += 1;
        return 'Recipes';
      },
    };
    const switches = vi.fn();
    const { rerender } = render(
      <SearchPalette
        {...props}
        query="s"
        hits={[counted]}
        onPick={() => {}}
        archived={{ included: false, onChange: switches }}
        meaning={meaning({ onChange: () => {} })}
      />,
    );
    const drawn = titleReads;
    expect(drawn).toBeGreaterThan(0);
    rerender(
      <SearchPalette
        {...props}
        query="so"
        hits={[counted]}
        onPick={() => {}}
        archived={{ included: false, onChange: switches }}
        meaning={meaning({ onChange: () => {} })}
      />,
    );
    expect(titleReads).toBe(drawn);
  });

  it('says why a search by meaning could not run', () => {
    render(<SearchPalette {...props} meaning={meaning({ problem: 'no network' })} />);
    expect(screen.getByText('Search by meaning is not available: no network')).toBeTruthy();
  });

  it('says nothing of meaning while searching by words', () => {
    render(<SearchPalette {...props} meaning={meaning({ on: false, problem: 'no network' })} />);
    expect(screen.queryByText(/not available/)).toBeNull();
  });

  it('shows a block found by meaning with its folder, not as a highlight, and opens it at its block', async () => {
    const onPick = vi.fn();
    const found = [
      { path: 'Meetings/Standup.md', title: 'Standup', snippet: 'Pay day moves', block: 'k3x9a1' },
    ];
    render(<SearchPalette {...props} hits={found} onPick={onPick} meaning={meaning()} />);
    expect(screen.getByText('Meetings')).toBeTruthy();
    expect(screen.queryByText('Highlight')).toBeNull();
    await userEvent.click(screen.getByRole('option'));
    expect(onPick).toHaveBeenCalledWith('Meetings/Standup.md', 'k3x9a1');
  });
});

describe('SearchPalette keeps the selected result in view (#372)', () => {
  /** jsdom lays nothing out, so it has no scrollIntoView: record who is asked to scroll. */
  function spyOnScrolls() {
    const scrolled: { element: Element; options: unknown }[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element, options?: unknown) {
      scrolled.push({ element: this, options });
    };
    return { scrolled, restore: () => (Element.prototype.scrollIntoView = original) };
  }

  it('scrolls the newly selected result into view, as little as it can', () => {
    const spy = spyOnScrolls();
    try {
      const { rerender } = render(<SearchPalette {...props} selected={0} />);
      rerender(<SearchPalette {...props} selected={1} />);
      expect(spy.scrolled).toHaveLength(1);
      expect(spy.scrolled[0]?.element.textContent).toContain('Recipes');
      expect(spy.scrolled[0]?.options).toEqual({ block: 'nearest' });
    } finally {
      spy.restore();
    }
  });

  it('arrows through the results where there is no scrollIntoView, as in jsdom', async () => {
    const original = Element.prototype.scrollIntoView;
    // As jsdom has it, and as an app test that arrows through real rows meets it.
    Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
    function Arrowed() {
      const [selected, setSelected] = useState(0);
      return (
        <SearchPalette
          {...props}
          selected={selected}
          onMove={(delta) => setSelected(selected + delta)}
        />
      );
    }
    try {
      render(<Arrowed />);
      await userEvent.type(
        screen.getByRole('searchbox', { name: 'Search the vault' }),
        '{ArrowDown}',
      );
      expect(screen.getAllByRole('option')[1]?.getAttribute('aria-selected')).toBe('true');
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('does not scroll as it opens, nor when it is drawn again with the same selection', () => {
    const spy = spyOnScrolls();
    try {
      const { rerender } = render(<SearchPalette {...props} selected={1} />);
      rerender(<SearchPalette {...props} selected={1} query="r" />);
      expect(spy.scrolled).toHaveLength(0);
    } finally {
      spy.restore();
    }
  });
});
