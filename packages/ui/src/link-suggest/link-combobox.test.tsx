// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NO_LINK_HINTS, type LinkHints } from '@dfai/domain';
import type { RelationChoice } from '../properties-panel.tsx';
import { LinkCombobox } from './link-combobox.tsx';
import { LinkHintsProvider, type LinkHintsSource } from './link-hints.tsx';
import { optionNamed, suggestedTitles } from './link-suggest.test-support.ts';

afterEach(cleanup);

const CHOICES: readonly RelationChoice[] = [
  { path: 'Projects/Garden shed.md', title: 'Garden shed', type: 'project' },
  { path: 'Areas/Garden.md', title: 'Garden', type: 'area' },
  { path: 'Projects/Larkspur Payroll.md', title: 'Larkspur Payroll', type: 'project' },
];

function field({
  hints = NO_LINK_HINTS,
  want = vi.fn(),
  onCreate,
  creates,
  current,
  onTyped,
}: {
  hints?: LinkHints;
  want?: () => void;
  onCreate?: (request: { target: string; name: string }) => Promise<void>;
  creates?: readonly string[];
  current?: string;
  onTyped?: (typed: string | null) => void;
} = {}) {
  const onPick = vi.fn();
  const onOpen = vi.fn();
  /** The keys that reach the page around the field, by name. */
  const pageKeys: string[] = [];
  const source: LinkHintsSource = { hints, notes: null, problem: null, want };
  render(
    <LinkHintsProvider value={source}>
      <div onKeyDown={(event) => pageKeys.push(event.key)}>
        <LinkCombobox
          label="Project"
          placeholder="Project…"
          choices={CHOICES}
          onPick={onPick}
          onOpen={onOpen}
          {...(current !== undefined && { current })}
          {...(creates !== undefined && { creates })}
          {...(onCreate !== undefined && { onCreate })}
          {...(onTyped !== undefined && { onTyped })}
        />
      </div>
    </LinkHintsProvider>,
  );
  return {
    input: screen.getByRole('combobox', { name: 'Project' }),
    onPick,
    onOpen,
    want,
    pageKeys,
  };
}

describe('LinkCombobox', () => {
  it('reads nothing until it opens, then asks for what it offers once', async () => {
    const { input, onOpen, want } = field();
    expect(onOpen).not.toHaveBeenCalled();
    expect(want).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
    await userEvent.click(input);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(want).toHaveBeenCalledTimes(1);
    expect(input.getAttribute('aria-expanded')).toBe('true');
  });

  it('suggests what meets what was typed, best first', async () => {
    const { input } = field();
    await userEvent.type(input, 'gar');
    expect(suggestedTitles()).toEqual(['Garden', 'Garden shed']);
  });

  it('shows each note’s type in its hue, and its folder', async () => {
    const { input } = field();
    await userEvent.type(input, 'lark');
    const option = screen.getByRole('option', { name: optionNamed('Larkspur Payroll') });
    expect(option.getAttribute('aria-label')).toBe('Larkspur Payroll, Projects, Projects');
    expect(option.querySelector('.link-suggest__type')?.getAttribute('data-hue')).not.toBeNull();
  });

  it('says the alias a note matched by', async () => {
    const hints: LinkHints = {
      aliases: new Map([['Projects/Larkspur Payroll.md', ['LP']]]),
      uses: new Map(),
    };
    const { input } = field({ hints });
    await userEvent.type(input, 'lp');
    const option = screen.getByRole('option', { name: optionNamed('Larkspur Payroll') });
    expect(option.querySelector('.link-suggest__alias')?.textContent).toBe('LP');
  });

  it('picks the best match on Enter, and empties the field', async () => {
    const { input, onPick } = field();
    await userEvent.type(input, 'gar{Enter}');
    expect(onPick).toHaveBeenCalledWith(CHOICES[1]);
    expect((input as HTMLInputElement).value).toBe('');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('moves with ↑ and ↓, wrapping, and picks the row moved to', async () => {
    const { input, onPick } = field();
    await userEvent.type(input, 'gar{ArrowDown}');
    expect(input.getAttribute('aria-activedescendant')).toMatch(/-1$/);
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(onPick).toHaveBeenCalledWith(CHOICES[0]);
  });

  it('takes the active row on Tab once something is typed', async () => {
    const { input, onPick } = field();
    await userEvent.type(input, 'lark');
    await userEvent.tab();
    expect(onPick).toHaveBeenCalledWith(CHOICES[2]);
  });

  it('picks nothing on Enter with nothing typed, leaving the key to the page', async () => {
    const { input, onPick, pageKeys } = field();
    await userEvent.click(input);
    await userEvent.keyboard('{Enter}');
    expect(onPick).not.toHaveBeenCalled();
    expect(pageKeys).toContain('Enter');
  });

  it('keeps the Enter that picks from the page', async () => {
    const { input, onPick, pageKeys } = field();
    await userEvent.type(input, 'gar{Enter}');
    expect(onPick).toHaveBeenCalled();
    expect(pageKeys).not.toContain('Enter');
  });

  it('closes the list on Esc, and only the list; a second Esc is the page’s', async () => {
    const { input, pageKeys } = field();
    await userEvent.type(input, 'gar');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(pageKeys).not.toContain('Escape');
    await userEvent.keyboard('{Escape}');
    expect(pageKeys.filter((key) => key === 'Escape')).toHaveLength(1);
  });

  it('leaves Esc to the page when nothing was typed, closing the list as it goes', async () => {
    const { input, pageKeys } = field();
    await userEvent.click(input);
    expect(screen.getByRole('listbox')).toBeDefined();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(pageKeys).toEqual(['Escape']);
  });

  it('leaves Enter to an input method that is composing', async () => {
    const { input, onPick } = field();
    await userEvent.type(input, 'gar');
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(onPick).not.toHaveBeenCalled();
  });

  it('picks a note clicked, without the field losing the focus first', async () => {
    const { input, onPick } = field();
    await userEvent.type(input, 'gar');
    await userEvent.click(screen.getByRole('option', { name: optionNamed('Garden shed') }));
    expect(onPick).toHaveBeenCalledWith(CHOICES[0]);
    expect(document.activeElement).toBe(input);
  });

  it('shows what it holds while nothing is typed, selected so typing replaces it', async () => {
    const { input } = field({ current: 'Garden' });
    expect((input as HTMLInputElement).value).toBe('Garden');
    await userEvent.click(input);
    await userEvent.keyboard('lark');
    expect((input as HTMLInputElement).value).toBe('lark');
    await userEvent.keyboard('{Escape}');
    expect((input as HTMLInputElement).value).toBe('Garden');
  });
});

describe('LinkCombobox — leaving the field', () => {
  it('takes back what was typed when no caller follows it', async () => {
    const { input } = field({ current: 'Garden' });
    await userEvent.type(input, 'lark');
    act(() => input.blur());
    expect((input as HTMLInputElement).value).toBe('Garden');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('keeps what was typed for a caller that follows it, and closes the list (#823)', async () => {
    const onTyped = vi.fn();
    const { input } = field({ current: 'Garden', onTyped });
    await userEvent.type(input, 'lark');
    act(() => input.blur());
    expect((input as HTMLInputElement).value).toBe('lark');
    expect(onTyped).toHaveBeenLastCalledWith('lark');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it.fails(
    'shows what it holds again when only blanks were typed, for a caller told nothing is typed (#823)',
    async () => {
      const onTyped = vi.fn();
      const { input } = field({ current: 'Garden', onTyped });
      await userEvent.type(input, '  ');
      act(() => input.blur());
      expect(onTyped).toHaveBeenLastCalledWith(null);
      expect((input as HTMLInputElement).value).toBe('Garden');
    },
  );

  it.fails('shows its prompt again, not blanks, when it holds nothing (#823)', async () => {
    const { input } = field({ onTyped: vi.fn() });
    await userEvent.type(input, '  ');
    act(() => input.blur());
    expect((input as HTMLInputElement).value).toBe('');
  });

  it.fails(
    'shows what it holds again as ↵ on a cleared field goes to the page (#823)',
    async () => {
      const { input, pageKeys } = field({ current: 'Garden', onTyped: vi.fn() });
      await userEvent.clear(input);
      await userEvent.keyboard('{Enter}');
      expect(pageKeys).toContain('Enter');
      expect((input as HTMLInputElement).value).toBe('Garden');
    },
  );
});

describe('LinkCombobox — where the list goes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('opens above a field near the window’s foot, no taller than the room there', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 400 });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.getAttribute('role') === 'combobox') {
        return DOMRect.fromRect({ x: 100, y: 360, width: 120, height: 24 });
      }
      if (this.getAttribute('role') === 'listbox') {
        const left = Number.parseFloat(this.style.left || '0');
        const top = Number.parseFloat(this.style.top || '0');
        return DOMRect.fromRect({ x: left, y: top, width: 260, height: 120 });
      }
      return DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 });
    });
    const { input } = field();
    await userEvent.click(input);
    const list = screen.getByRole('listbox', { name: 'Suggested notes' });
    // 360 above the field less the gaps: the room above, more than the 12 below.
    expect(Number.parseFloat(list.style.maxHeight)).toBe(280);
    expect(Number.parseFloat(list.style.top)).toBeLessThan(360);
  });

  it('follows its field when what is around it grows and moves it, with no scroll (#823)', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    // jsdom lays nothing out and has no ResizeObserver: both are stood in for.
    const watching: { resized: () => void; watched: Element[] }[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        readonly watched: Element[] = [];
        constructor(readonly resized: () => void) {
          watching.push(this);
        }
        observe(element: Element) {
          this.watched.push(element);
        }
        unobserve() {}
        disconnect() {
          this.watched.length = 0;
        }
      },
    );
    let fieldTop = 100;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.getAttribute('role') === 'combobox') {
        return DOMRect.fromRect({ x: 100, y: fieldTop, width: 120, height: 24 });
      }
      if (this.getAttribute('role') === 'listbox') {
        const left = Number.parseFloat(this.style.left || '0');
        const top = Number.parseFloat(this.style.top || '0');
        return DOMRect.fromRect({ x: left, y: top, width: 260, height: 120 });
      }
      return DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 });
    });
    const { input } = field();
    await userEvent.type(input, 'gar');
    const list = screen.getByRole('listbox', { name: 'Suggested notes' });
    expect(Number.parseFloat(list.style.top)).toBe(128);

    // A row above it grows — a meeting's import lands — and the field moves down 90px.
    fieldTop = 190;
    const page = input.closest('div');
    for (const each of watching) if (page !== null && each.watched.includes(page)) each.resized();

    expect(Number.parseFloat(list.style.top)).toBe(218);
  });

  /** Stands in for ResizeObserver, counting the ones still watching something. */
  function countWatchers() {
    const watchers = new Set<object>();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {
          watchers.add(this);
        }
        unobserve() {}
        disconnect() {
          watchers.delete(this);
        }
      },
    );
    return watchers;
  }

  it('stops watching what holds its field once the list closes on Esc (#823)', async () => {
    const watchers = countWatchers();
    const { input } = field();
    await userEvent.type(input, 'gar');
    expect(watchers.size).toBe(1);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(watchers.size).toBe(0);
  });

  it('stops watching once the field is left, with what was typed kept (#823)', async () => {
    const watchers = countWatchers();
    const { input } = field({ onTyped: vi.fn() });
    await userEvent.type(input, 'gar');
    expect(watchers.size).toBe(1);
    act(() => input.blur());
    expect(watchers.size).toBe(0);
  });

  it('stops watching once a note is picked (#823)', async () => {
    const watchers = countWatchers();
    const { input, onPick } = field();
    await userEvent.type(input, 'lark{Enter}');
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(watchers.size).toBe(0);
  });
});

describe('LinkCombobox — making a note of what was typed', () => {
  it('offers "Create <type> ‘…’" when no note is called that, and makes it', async () => {
    const onCreate = vi.fn(async () => {});
    const { input } = field({ onCreate, creates: ['project', 'area'] });
    await userEvent.type(input, 'Gard');
    const create = screen.getByRole('option', { name: 'Create area ‘Gard’' });
    expect(screen.getByRole('option', { name: 'Create project ‘Gard’' })).toBeDefined();
    await userEvent.click(create);
    expect(onCreate).toHaveBeenCalledWith({ target: 'area', name: 'Gard' });
  });

  it('offers none once a note is called what was typed', async () => {
    const { input } = field({ onCreate: async () => {}, creates: ['project'] });
    await userEvent.type(input, 'garden');
    expect(suggestedTitles()).toEqual(['Garden', 'Garden shed']);
    expect(screen.queryByRole('option', { name: /^Create/ })).toBeNull();
  });

  it('makes it on Enter when nothing else matches, and once only', async () => {
    let finish = () => {};
    const onCreate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { input } = field({ onCreate, creates: ['project'] });
    await userEvent.type(input, 'Tobias Fenn{Enter}{Enter}');
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith({ target: 'project', name: 'Tobias Fenn' });
    finish();
  });

  it('says why a note could not be made, and stays open', async () => {
    const onCreate = vi.fn(async () => {
      throw new Error('There is no project type to make one of.');
    });
    const { input } = field({ onCreate, creates: ['project'] });
    await userEvent.type(input, 'Tobias{Enter}');
    expect((await screen.findByRole('alert')).textContent).toBe(
      'There is no project type to make one of.',
    );
    expect(screen.getByRole('listbox')).toBeDefined();
  });

  it('offers nothing to make where notes cannot be made', async () => {
    const { input } = field();
    await userEvent.type(input, 'Tobias');
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
