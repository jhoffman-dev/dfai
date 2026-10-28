// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createVaultPath, noteNames, type PropertyDef, type PropertyKind } from '@dfai/domain';
import { pickSuggestion, suggestedTitles } from './link-suggest/link-suggest.test-support.ts';
import { NoteNamesProvider } from './note-names.tsx';
import { PropertiesPanel, type NewProperty, type PropertyRow } from './properties-panel.tsx';

const def = (kind: PropertyKind, extra: Partial<PropertyDef> = {}): PropertyDef => ({
  key: 'field',
  kind,
  label: 'Field',
  required: false,
  options: [],
  target: null,
  many: false,
  ...extra,
});

const row = (
  kind: PropertyKind,
  value: unknown,
  extra: Partial<PropertyDef> = {},
): PropertyRow => ({
  def: def(kind, extra),
  value,
  error: null,
});

const panel = (rows: PropertyRow[], onChange = vi.fn(), choices = {}) => {
  render(
    <PropertiesPanel
      typeName="company"
      rows={rows}
      relationChoices={choices}
      onChange={onChange}
    />,
  );
  return onChange;
};

describe('PropertiesPanel', () => {
  it('shows a panel for a typed note with nothing filled in yet', () => {
    panel([]);
    expect(screen.getByRole('region', { name: 'Properties' })).toBeDefined();
  });

  it('renders nothing for a note with no type and no properties', () => {
    const { container } = render(
      <PropertiesPanel typeName={null} rows={[]} relationChoices={{}} onChange={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('labels each property', () => {
    panel([row('text', 'x')]);
    expect(screen.getByLabelText('Field')).toBeDefined();
  });

  it('reports a text change', () => {
    const onChange = panel([row('text', '')]);
    // A change event rather than keystrokes: the input is controlled, and its
    // value comes from the note rather than from what was typed.
    fireEvent.change(screen.getByLabelText('Field'), { target: { value: 'hello' } });
    expect(onChange).toHaveBeenLastCalledWith('field', 'hello');
  });

  it('clears a text property rather than storing an empty string', async () => {
    const onChange = panel([row('text', 'x')]);
    await userEvent.clear(screen.getByLabelText('Field'));
    expect(onChange).toHaveBeenLastCalledWith('field', null);
  });

  it('reports a number as a number', () => {
    const onChange = panel([row('number', '')]);
    fireEvent.change(screen.getByLabelText('Field'), { target: { value: '42' } });
    expect(onChange).toHaveBeenLastCalledWith('field', 42);
  });

  it('reports a checkbox as a boolean', async () => {
    const onChange = panel([row('checkbox', false)]);
    await userEvent.click(screen.getByLabelText('Field'));
    expect(onChange).toHaveBeenLastCalledWith('field', true);
  });

  it('shows a checkbox as checked for the string the file holds', () => {
    panel([row('checkbox', 'true')]);
    expect((screen.getByLabelText('Field') as HTMLInputElement).checked).toBe(true);
  });

  it('offers the declared options for a select', () => {
    panel([row('select', 'draft', { options: ['draft', 'done'] })]);
    const options = [...screen.getByLabelText('Field').querySelectorAll('option')];
    expect(options.map((option) => option.textContent)).toEqual(['—', 'Draft', 'Done']);
    expect(options.map((option) => option.value)).toEqual(['', 'draft', 'done']);
  });

  it('draws a status as a pill in its column colours', () => {
    panel([row('select', 'doing', { key: 'status', options: ['backlog', 'doing'] })]);
    const pill = screen.getByLabelText('Field').closest('.props__pill');
    expect(pill?.getAttribute('data-tone')).toBe('doing');
  });

  it('draws an unset status as an empty pill rather than a coloured one', () => {
    panel([row('select', null, { options: ['backlog'] })]);
    const pill = screen.getByLabelText('Field').closest('.props__pill');
    expect(pill?.getAttribute('data-tone')).toBe('empty');
  });

  it('reports a chosen option', async () => {
    const onChange = panel([row('select', 'draft', { options: ['draft', 'done'] })]);
    await userEvent.selectOptions(screen.getByLabelText('Field'), 'done');
    expect(onChange).toHaveBeenLastCalledWith('field', 'done');
  });

  it('shows a list property as a comma-separated line', () => {
    panel([row('multiSelect', ['a', 'b'])]);
    expect((screen.getByLabelText('Field') as HTMLInputElement).value).toBe('a, b');
  });

  it('reports a list property back as a list', () => {
    const onChange = panel([row('multiSelect', [])]);
    fireEvent.change(screen.getByLabelText('Field'), { target: { value: 'a, b' } });
    expect(onChange).toHaveBeenLastCalledWith('field', ['a', 'b']);
  });

  it('shows a list item holding a comma in quotes, so it reads as one item (#50)', () => {
    panel([row('multiSelect', ['Payroll, Larkspur', 'say "hi"', 'Quill'])]);
    expect((screen.getByLabelText('Field') as HTMLInputElement).value).toBe(
      '"Payroll, Larkspur", "say ""hi""", Quill',
    );
  });

  it('keeps a list item holding a comma whole when another is added, removed or moved (#50)', async () => {
    const onChange = panel([row('multiSelect', ['Payroll, Larkspur', 'Quill'])]);
    const field = screen.getByLabelText('Field');
    await userEvent.type(field, ', Mara');
    expect(onChange).toHaveBeenLastCalledWith('field', ['Payroll, Larkspur', 'Quill', 'Mara']);
    fireEvent.change(field, { target: { value: '"Payroll, Larkspur"' } });
    expect(onChange).toHaveBeenLastCalledWith('field', ['Payroll, Larkspur']);
    fireEvent.change(field, { target: { value: 'Quill, "Payroll, Larkspur"' } });
    expect(onChange).toHaveBeenLastCalledWith('field', ['Quill', 'Payroll, Larkspur']);
  });

  it('reads a new item typed in quotes as one item, comma and all (#50)', async () => {
    const onChange = panel([row('multiSelect', [])]);
    await userEvent.type(screen.getByLabelText('Field'), '"Mara, Inc.", Quill');
    expect(onChange).toHaveBeenLastCalledWith('field', ['Mara, Inc.', 'Quill']);
  });

  it('drops blank entries from a list rather than storing them', () => {
    const onChange = panel([row('multiSelect', [])]);
    fireEvent.change(screen.getByLabelText('Field'), { target: { value: 'a, , b,' } });
    expect(onChange).toHaveBeenLastCalledWith('field', ['a', 'b']);
  });

  it('offers only the notes given for a relation', async () => {
    panel([row('relation', null, { target: 'person' })], vi.fn(), {
      field: [{ path: 'Ada.md', title: 'Ada' }],
    });
    const field = screen.getByLabelText('Field');
    expect(field.getAttribute('placeholder')).toBe('— no person —');
    await userEvent.click(field);
    expect(suggestedTitles()).toEqual(['Ada']);
  });
  it('writes a relation as a wiki link', async () => {
    const onChange = panel([row('relation', null, { target: 'person' })], vi.fn(), {
      field: [{ path: 'Ada.md', title: 'Ada' }],
    });
    await pickSuggestion(screen.getByLabelText('Field'), 'Ada');
    expect(onChange).toHaveBeenLastCalledWith('field', '[[Ada]]');
  });
  it('shows a url property as a url field', () => {
    panel([row('url', 'https://example.com')]);
    expect(screen.getByLabelText('Field').getAttribute('type')).toBe('url');
  });

  it('shows only the date part of a date property', () => {
    panel([row('date', '2026-09-20T10:00:00Z')]);
    expect((screen.getByLabelText('Field') as HTMLInputElement).value).toBe('2026-09-20');
  });

  it('reads a date the way a person says it, over the date field', () => {
    panel([row('date', '2026-09-22')]);
    expect(screen.getByText('Tue, Sep 22, 2026')).toBeDefined();
    expect(screen.getByLabelText('Field').getAttribute('type')).toBe('date');
  });

  it('shows a date it cannot read as it is written, and an empty one as Empty', () => {
    panel([row('date', 'someday'), row('date', null, { key: 'other', label: 'Other' })]);
    expect(screen.getByText('someday')).toBeDefined();
    expect(screen.getByText('Empty')).toBeDefined();
  });

  it('still edits a date through the date field', () => {
    const onChange = panel([row('date', '2026-09-22')]);
    fireEvent.change(screen.getByLabelText('Field'), { target: { value: '2026-10-01' } });
    // A date is written when the field is left, not on each keystroke.
    fireEvent.blur(screen.getByLabelText('Field'));
    expect(onChange).toHaveBeenLastCalledWith('field', '2026-10-01');
  });

  it('keeps the time of a date-time when only its day is changed', () => {
    // The field shows the date part alone, so the time is never on screen —
    // changing the day must not silently drop it from the file.
    const onChange = panel([row('date', '2026-09-22T14:30')]);
    fireEvent.change(screen.getByLabelText('Field'), { target: { value: '2026-09-23' } });
    fireEvent.blur(screen.getByLabelText('Field'));
    expect(onChange).toHaveBeenLastCalledWith('field', '2026-09-23T14:30');
  });

  it('writes nothing while the date field is cleared part-way', () => {
    // WebKit reports '' for a date with any part missing — one Backspace.
    const onChange = panel([row('date', '2026-09-22T14:30')]);
    const field = screen.getByLabelText('Field');
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.blur(field);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('writes nothing for a day typed only part-way, until the field is left', () => {
    const onChange = panel([row('date', '2026-09-22')]);
    const field = screen.getByLabelText('Field');
    fireEvent.change(field, { target: { value: '0002-09-22' } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: '2027-09-22' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledExactlyOnceWith('field', '2027-09-22');
  });

  it('clears a date only through its Clear button', async () => {
    const onChange = panel([row('date', '2026-09-22T14:30')]);
    await userEvent.click(screen.getByRole('button', { name: 'Clear Field' }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith('field', null);
  });

  it('offers no Clear for a date that is already empty', () => {
    panel([row('date', null)]);
    expect(screen.getByText('Empty')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Clear Field' })).toBeNull();
  });

  it('shows the time of a date-time beside its day', () => {
    panel([row('date', '2026-09-22T14:30')]);
    expect(screen.getByText('Tue, Sep 22, 2026, 14:30')).toBeDefined();
  });

  it('announces a property that is not valid', () => {
    render(
      <PropertiesPanel
        typeName="company"
        rows={[{ def: def('text'), value: '', error: 'Field is required' }]}
        relationChoices={{}}
        onChange={() => {}}
      />,
    );
    expect(screen.getByRole('alert').textContent).toBe('Field is required');
  });
});

describe('typing faster than the file is written', () => {
  // The rows come from the file, which lags each keystroke's write. A field
  // that showed only the file's value put every keystroke back, and "412"
  // typed quickly reached the file as "42".
  it('keeps every character of a text property', async () => {
    const onChange = panel([row('text', '')]);
    await userEvent.type(screen.getByLabelText('Field'), 'hello');
    expect((screen.getByLabelText('Field') as HTMLInputElement).value).toBe('hello');
    expect(onChange).toHaveBeenLastCalledWith('field', 'hello');
  });

  it('keeps every digit of a number', async () => {
    const onChange = panel([row('number', null)]);
    await userEvent.type(screen.getByLabelText('Field'), '412');
    expect(onChange).toHaveBeenLastCalledWith('field', 412);
  });

  it('keeps the comma a list is being typed with', async () => {
    const onChange = panel([row('multiSelect', [])]);
    await userEvent.type(screen.getByLabelText('Field'), 'a, b');
    expect((screen.getByLabelText('Field') as HTMLInputElement).value).toBe('a, b');
    expect(onChange).toHaveBeenLastCalledWith('field', ['a', 'b']);
  });

  it('shows what the file says once the field is left', async () => {
    const view = render(
      <PropertiesPanel
        typeName="t"
        rows={[row('text', 'old')]}
        relationChoices={{}}
        onChange={vi.fn()}
      />,
    );
    await userEvent.type(screen.getByLabelText('Field'), '!');
    await userEvent.tab();
    view.rerender(
      <PropertiesPanel
        typeName="t"
        rows={[row('text', 'new')]}
        relationChoices={{}}
        onChange={vi.fn()}
      />,
    );
    expect((screen.getByLabelText('Field') as HTMLInputElement).value).toBe('new');
  });
});

describe('adding a property', () => {
  const adding = ({
    rows = [row('text', 'x', { key: 'status', label: 'Status' })],
    typeName = 'book' as string | null,
    onAdd = vi.fn(async (property: NewProperty) => property.key),
  } = {}) => {
    const view = render(
      <PropertiesPanel
        typeName={typeName}
        typeLabel={typeName === null ? null : 'Book'}
        rows={rows}
        relationChoices={{}}
        relationTargets={[
          { name: 'book', label: 'Book' },
          { name: 'task', label: 'Task' },
        ]}
        onChange={() => {}}
        onAdd={onAdd}
      />,
    );
    return { onAdd, view };
  };
  const popover = () => screen.getByRole('dialog', { name: 'Add a property' });
  const name = () => within(popover()).getByRole('textbox', { name: 'Property name' });
  const kind = () => within(popover()).getByRole('combobox', { name: 'Kind' });
  const submit = () => within(popover()).getByRole('button', { name: 'Add property' });
  const start = () => userEvent.click(screen.getByRole('button', { name: 'Add a property' }));

  it('is named, given a kind, and added to the type by default', async () => {
    const { onAdd } = adding();
    await start();
    await userEvent.type(name(), 'Due date');
    await userEvent.selectOptions(kind(), 'date');
    expect(
      (
        within(popover()).getByRole('radio', {
          name: 'Add to Book (every book)',
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    await userEvent.click(submit());
    expect(onAdd).toHaveBeenCalledExactlyOnceWith({
      label: 'Due date',
      key: 'due_date',
      kind: 'date',
      scope: 'type',
      target: null,
      many: false,
    });
  });

  it('keeps what was typed while the kind is being chosen', async () => {
    // The old field threw the name away the moment it lost the focus.
    const { onAdd } = adding();
    await start();
    await userEvent.type(name(), 'Pages');
    await userEvent.click(kind());
    await userEvent.selectOptions(kind(), 'number');
    await userEvent.click(submit());
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ key: 'pages', kind: 'number' }));
  });

  it('adds to this note alone when asked, on Enter', async () => {
    const { onAdd } = adding();
    await start();
    await userEvent.click(within(popover()).getByRole('radio', { name: 'Only this note' }));
    await userEvent.type(name(), 'Signed{Enter}');
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ key: 'signed', scope: 'note' }));
  });

  it('asks a relation what it points at, and whether it holds several notes', async () => {
    const { onAdd } = adding();
    await start();
    await userEvent.type(name(), 'Tasks');
    await userEvent.selectOptions(kind(), 'relation');
    await userEvent.selectOptions(
      within(popover()).getByRole('combobox', { name: 'Points at' }),
      'task',
    );
    await userEvent.click(within(popover()).getByRole('checkbox', { name: 'Several notes' }));
    await userEvent.click(submit());
    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'relation', target: 'task', many: true }),
    );
  });

  it('offers a select or a relation only to the type, which is where their options live', async () => {
    adding();
    await start();
    await userEvent.selectOptions(kind(), 'select');
    await userEvent.click(within(popover()).getByRole('radio', { name: 'Only this note' }));
    const option = (value: string) =>
      within(kind()).getByRole('option', { name: new RegExp(`^${value}`) }) as HTMLOptionElement;
    expect(option('Select').disabled).toBe(true);
    expect(option('Relation').disabled).toBe(true);
    expect(option('Checkbox').disabled).toBe(false);
    expect((kind() as HTMLSelectElement).value).toBe('text');
  });

  it('adds to a note with no type, which has nowhere else to add it', async () => {
    const { onAdd } = adding({ typeName: null, rows: [row('text', 'x', { key: 'owner' })] });
    await start();
    expect(within(popover()).queryByRole('radio')).toBeNull();
    await userEvent.type(name(), 'Due{Enter}');
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ key: 'due', scope: 'note' }));
  });

  it('refuses a name already there, or one DFAI keeps, and says why', async () => {
    const { onAdd } = adding();
    await start();
    await userEvent.type(name(), 'Status');
    expect(within(popover()).getByRole('alert').textContent).toMatch(/already has/);
    expect((submit() as HTMLButtonElement).disabled).toBe(true);
    await userEvent.clear(name());
    await userEvent.type(name(), 'modified{Enter}');
    expect(within(popover()).getByRole('alert').textContent).toMatch(/kept for DFAI/);
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('gives up on Escape or Cancel', async () => {
    const { onAdd } = adding();
    await start();
    await userEvent.type(name(), 'owner{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Add a property' })).toBeNull();
    await start();
    await userEvent.click(within(popover()).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Add a property' })).toBeNull();
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('puts the focus in the new row once it is there', async () => {
    const onAdd = vi.fn(async () => 'pages');
    const { view } = adding({ onAdd });
    await start();
    await userEvent.type(name(), 'Pages{Enter}');
    expect(screen.queryByRole('dialog', { name: 'Add a property' })).toBeNull();
    view.rerender(
      <PropertiesPanel
        typeName="book"
        typeLabel="Book"
        rows={[row('number', null, { key: 'pages', label: 'Pages' })]}
        relationChoices={{}}
        onChange={() => {}}
        onAdd={onAdd}
      />,
    );
    expect(document.activeElement).toBe(screen.getByLabelText('Pages'));
  });

  it('stays open and says why when the property could not be added', async () => {
    adding({ onAdd: vi.fn(async () => Promise.reject(new Error('The type file moved'))) });
    await start();
    await userEvent.type(name(), 'Pages{Enter}');
    expect(within(popover()).getByRole('alert').textContent).toBe('The type file moved');
    expect((name() as HTMLInputElement).value).toBe('Pages');
  });

  it('is not offered where nothing can be added', () => {
    panel([row('text', 'x')]);
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Add a property' })).toBeNull();
  });
});

describe('a relation that holds several notes', () => {
  const choices = {
    field: [
      { path: 'Write report.md', title: 'Write report' },
      { path: 'Book flights.md', title: 'Book flights' },
      { path: 'Pay rent.md', title: 'Pay rent' },
    ],
  };
  const several = (value: unknown) =>
    panel([row('relation', value, { target: 'task', many: true })], vi.fn(), choices);

  it('shows a chip for each note it links', () => {
    several(['[[Write report]]', '[[Book flights]]']);
    const chips = within(screen.getByRole('list', { name: 'Field' })).getAllByRole('listitem');
    expect(chips.map((chip) => chip.textContent)).toEqual(['Write report', 'Book flights']);
  });

  /** The rule the last change was given as, worked out against `current`. */
  const lastRule = (onChange: ReturnType<typeof vi.fn>, current: unknown) => {
    const [key, rule] = onChange.mock.lastCall ?? [];
    expect(key).toBe('field');
    return (rule as (value: unknown) => unknown)(current);
  };

  it('adds another, keeping the ones it has', async () => {
    const onChange = several(['[[Write report]]']);
    await pickSuggestion(screen.getByRole('combobox', { name: 'Field' }), 'Book flights');
    expect(lastRule(onChange, ['[[Write report]]'])).toEqual([
      '[[Write report]]',
      '[[Book flights]]',
    ]);
  });

  it('adds to what the file holds when the write lands, not to what was shown', async () => {
    // Two picked in quick succession: the second is added to the first even
    // though the first had not come back from the file when it was picked.
    const onChange = several([]);
    await pickSuggestion(screen.getByRole('combobox', { name: 'Field' }), 'Book flights');
    expect(lastRule(onChange, ['[[Write report]]'])).toEqual([
      '[[Write report]]',
      '[[Book flights]]',
    ]);
  });

  it('offers to add only the notes not linked yet, and stays ready for another', async () => {
    several(['[[Write report]]']);
    const add = screen.getByRole('combobox', { name: 'Field' }) as HTMLInputElement;
    expect(add.placeholder).toBe('Add a task…');
    await userEvent.click(add);
    expect(suggestedTitles()).toEqual(['Book flights', 'Pay rent']);
    await pickSuggestion(add, 'Pay rent');
    expect(add.value).toBe('');
    expect(document.activeElement).toBe(add);
  });
  it('takes one note out with its chip', async () => {
    const onChange = several(['[[Write report]]', '[[Book flights]]']);
    await userEvent.click(screen.getByRole('button', { name: 'Remove Write report from Field' }));
    expect(lastRule(onChange, ['[[Write report]]', '[[Book flights]]'])).toEqual([
      '[[Book flights]]',
    ]);
  });

  it('reads a single link written by hand as the first of the list', () => {
    several('[[Pay rent]]');
    const chips = within(screen.getByRole('list', { name: 'Field' })).getAllByRole('listitem');
    expect(chips.map((chip) => chip.textContent)).toEqual(['Pay rent']);
  });
});

describe('a property whose value has structure inside it', () => {
  const structured = (value: unknown) =>
    render(
      <PropertiesPanel
        typeName="dashboard"
        rows={[
          {
            def: { key: 'widgets', label: 'widgets', kind: 'text', many: false, options: [] },
            value,
            error: null,
          } as unknown as PropertyRow,
        ]}
        relationChoices={{}}
        onChange={() => {}}
      />,
    );

  it('never renders it as [object Object]', () => {
    const { container } = structured([{ kind: 'number' }, { kind: 'bar' }]);
    expect(container.textContent).not.toContain('[object Object]');
  });

  /**
   * The bug this guards: the value went into a text input, so one keystroke
   * wrote "[object Object],[object Object]" over a whole dashboard definition.
   */
  it('does not offer it as a text box that would flatten it', () => {
    structured([{ kind: 'number' }, { kind: 'bar' }]);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('says how much is in there', () => {
    structured([{ kind: 'number' }, { kind: 'bar' }]);
    expect(screen.getByText('2 items')).toBeDefined();
  });

  it('counts one item singly', () => {
    structured([{ kind: 'number' }]);
    expect(screen.getByText('1 item')).toBeDefined();
  });

  it('counts the keys of a mapping', () => {
    structured({ due_on: 'due', owner: 'assignee' });
    expect(screen.getByText('2 keys')).toBeDefined();
  });

  it('still edits an ordinary list of words as text', () => {
    structured(['design', 'reading']);
    expect(screen.getByRole('textbox')).toBeDefined();
  });
});

describe('two panels on screen at once, as in a split', () => {
  it('labels each field in its own panel, not the first one', () => {
    panel([row('text', 'left')]);
    panel([row('text', 'right')]);
    const fields = screen.getAllByLabelText('Field') as HTMLInputElement[];
    expect(fields.map((field) => field.value)).toEqual(['left', 'right']);
  });
});

describe('a relation read against the vault', () => {
  const names = noteNames([
    { path: createVaultPath('P-01.md'), title: 'DFAI' },
    { path: createVaultPath('Ada.md'), title: 'Ada Lovelace' },
  ]);
  const relation = (value: unknown, extra: Partial<PropertyDef> = {}) => {
    const onChange = vi.fn();
    const onOpenNote = vi.fn();
    render(
      <NoteNamesProvider value={names}>
        <PropertiesPanel
          typeName="task"
          rows={[row('relation', value, { target: 'project', ...extra })]}
          relationChoices={{ field: [{ path: 'P-01.md', title: 'DFAI' }] }}
          onChange={onChange}
          onOpenNote={onOpenNote}
        />
      </NoteNamesProvider>,
    );
    return { onChange, onOpenNote };
  };

  it('names the linked note by its title, and opens it', async () => {
    const { onOpenNote } = relation('[[P-01]]');
    await userEvent.click(screen.getByRole('button', { name: 'Open DFAI' }));
    expect(onOpenNote).toHaveBeenCalledExactlyOnceWith('P-01.md');
    expect(screen.getByRole('region', { name: 'Properties' }).textContent).not.toContain('[[');
  });

  it('shows the alias a link was given', () => {
    relation('[[P-01|The app]]');
    expect(screen.getByRole('button', { name: 'Open The app' })).toBeDefined();
  });

  it('shows a link to nothing as its bare name, marked missing', () => {
    relation('[[archive/Gone]]');
    expect(screen.getByText('Gone').getAttribute('data-missing')).toBe('true');
  });

  it('links a titled note by its filename, which is what finds it', async () => {
    const { onChange } = relation(null);
    await pickSuggestion(screen.getByRole('combobox', { name: 'Field' }), 'DFAI');
    expect(onChange).toHaveBeenLastCalledWith('field', '[[P-01]]');
  });
  it('offers to change the one note, without offering it again', async () => {
    relation('[[P-01]]');
    const picker = screen.getByRole('combobox', { name: 'Field' });
    expect(picker.getAttribute('placeholder')).toBe('Change project…');
    await userEvent.click(picker);
    expect(suggestedTitles()).toEqual([]);
  });
  it('shows links under a key no type declares, with nothing to pick from', () => {
    relation('[[Ada]]', { target: null });
    expect(screen.getByRole('button', { name: 'Open Ada Lovelace' })).toBeDefined();
    expect(screen.queryByRole('combobox')).toBeNull();
  });
});

describe('making a new note from a relation (issue #15)', () => {
  const company = () => row('relation', null, { target: 'company' });
  const withCreate = (
    onCreateRelated: (args: { target: string; name: string }) => Promise<string>,
  ) => {
    const onChange = vi.fn();
    render(
      <PropertiesPanel
        typeName="person"
        rows={[company()]}
        relationChoices={{ field: [{ path: 'Acme.md', title: 'Acme' }] }}
        onChange={onChange}
        onCreateRelated={onCreateRelated}
      />,
    );
    return onChange;
  };

  it('offers to make a company of what was typed, after the notes it meets', async () => {
    withCreate(vi.fn());
    await userEvent.type(screen.getByLabelText('Field'), 'a');
    expect(suggestedTitles()).toEqual(['Acme']);
    expect(screen.getByRole('option', { name: 'Create company ‘a’' })).toBeDefined();
    await userEvent.type(screen.getByLabelText('Field'), 'cme');
    expect(screen.queryByRole('option', { name: /^Create/ })).toBeNull();
  });
  it('makes the note named as typed and links what was made', async () => {
    const onCreateRelated = vi.fn(async () => '[[Larkspur Payroll]]');
    const onChange = withCreate(onCreateRelated);

    await userEvent.type(screen.getByLabelText('Field'), 'Larkspur Payroll');
    await userEvent.click(
      screen.getByRole('option', { name: 'Create company ‘Larkspur Payroll’' }),
    );

    expect(onCreateRelated).toHaveBeenCalledWith({
      target: 'company',
      name: 'Larkspur Payroll',
    });
    expect(onChange).toHaveBeenLastCalledWith('field', '[[Larkspur Payroll]]');
    expect(screen.queryByRole('listbox')).toBeNull();
  });
  it('says why a note was not made, and links nothing', async () => {
    const onChange = withCreate(async () => {
      throw new Error('No room for it');
    });
    await userEvent.type(screen.getByLabelText('Field'), 'Larkspur Payroll{Enter}');
    expect((await screen.findByRole('alert')).textContent).toContain('No room for it');
    expect(onChange).not.toHaveBeenCalled();
  });
  it('makes nothing for Escape or an empty name', async () => {
    const onCreateRelated = vi.fn(async () => '[[x]]');
    withCreate(onCreateRelated);
    await userEvent.type(screen.getByLabelText('Field'), '  {Enter}');
    expect(screen.queryByRole('option', { name: /^Create/ })).toBeNull();
    expect(onCreateRelated).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText('Field'), 'x{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onCreateRelated).not.toHaveBeenCalled();
  });
  it('offers no new note where the panel cannot make one', async () => {
    panel([company()], vi.fn(), { field: [{ path: 'Acme.md', title: 'Acme' }] });
    await userEvent.type(screen.getByLabelText('Field'), 'Larkspur');
    expect(screen.queryByRole('option', { name: /^Create/ })).toBeNull();
  });
});
