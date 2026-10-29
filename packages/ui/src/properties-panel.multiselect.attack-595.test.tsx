// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { listAsInput, listFromInput } from '@dfai/domain';
import { PropertiesPanel, type PropertyRow } from './properties-panel.tsx';

/*
 * Attack on PR #595 (#50). The multi-select box writes the file on every
 * keystroke, so each line it holds on the way to an edit is a save: none may
 * lose an item the person did not remove, or write a value the next read
 * shows as something else.
 */

const multiSelect = (value: unknown): PropertyRow => ({
  def: {
    key: 'clients',
    kind: 'multiSelect',
    label: 'Clients',
    required: false,
    options: [],
    target: null,
    many: false,
  },
  value,
  error: null,
});

const panel = (value: unknown) => {
  const onChange = vi.fn();
  render(
    <PropertiesPanel
      typeName="company"
      rows={[multiSelect(value)]}
      relationChoices={{}}
      onChange={onChange}
    />,
  );
  return { onChange, field: screen.getByLabelText('Clients') as HTMLInputElement };
};

/** Every list the box wrote, in order. */
const saved = (onChange: ReturnType<typeof vi.fn>): unknown[][] =>
  onChange.mock.calls.map(([, value]) => value as unknown[]);

/** Types `lines` into the focused box one change at a time, as keystrokes would. */
function typeLines(field: HTMLInputElement, lines: readonly string[]) {
  fireEvent.focus(field);
  for (const line of lines) fireEvent.change(field, { target: { value: line } });
}

/** Each step of deleting a line's characters from `at` backwards, one by one. */
const deletingBack = (line: string, at: number, count: number): string[] =>
  Array.from({ length: count }, (_, step) => line.slice(0, at - step - 1) + line.slice(at));

describe('the multi-select box while it is being edited (attack #595)', () => {
  it('never saves a list missing an untouched item while a closing quote is deleted', () => {
    const { onChange, field } = panel(['Payroll, Larkspur', 'Quill']);
    const shown = field.value; // "Payroll, Larkspur", Quill
    const closing = shown.indexOf('",') + 1;
    typeLines(field, deletingBack(shown, closing, 1));
    for (const list of saved(onChange)) expect(list).toContain('Quill');
  });

  it('never saves a list missing an untouched item while an opening quote is typed before another', () => {
    const { onChange, field } = panel(['Payroll', 'Quill', 'Mara']);
    typeLines(field, ['Payroll, "Quill, Mara']);
    // While the quote is open nothing is saved, so no save can be missing Mara.
    expect(onChange).not.toHaveBeenCalled();
    // Closing it is the person asking for "Quill, Mara" as one item: that is saved.
    typeLines(field, ['Payroll, "Quill, Mara"']);
    expect(saved(onChange)).toEqual([['Payroll', 'Quill, Mara']]);
  });

  it('never writes the text "null" for an empty item it was not asked to change', async () => {
    const { onChange, field } = panel(['Quill', null]);
    await userEvent.type(field, ', Mara');
    expect(onChange).toHaveBeenLastCalledWith('clients', ['Quill', 'Mara']);
  });

  it('keeps an untouched item holding a line break when another item is added', async () => {
    const { onChange, field } = panel(['line one\nline two', 'Quill']);
    await userEvent.type(field, ', Mara');
    expect(onChange).toHaveBeenLastCalledWith('clients', ['line one\nline two', 'Quill', 'Mara']);
  });

  it('typed key by key into an empty box, saves no item holding a stray quote and ends as two', async () => {
    const { onChange, field } = panel([]);
    await userEvent.type(field, '"Payroll, Larkspur", Quill');
    for (const list of saved(onChange)) {
      for (const item of list) expect(String(item)).not.toContain('"');
    }
    expect(onChange).toHaveBeenLastCalledWith('clients', ['Payroll, Larkspur', 'Quill']);
  });

  it('writes only lists that read back as themselves, at every step of an edit', () => {
    const { onChange, field } = panel(['Payroll, Larkspur', 'say "hi"', 'Quill']);
    const shown = field.value;
    typeLines(field, [
      `${shown}, "`,
      `${shown}, "Mara`,
      `${shown}, "Mara, Inc."`,
      `"Mara, Inc.", ${shown}`, // a paste at the front
      `${shown}, "`.replace('""hi""', '""hi"'), // a doubled quote half deleted
    ]);
    for (const list of saved(onChange)) {
      expect(listFromInput(listAsInput(list as string[]))).toEqual(list);
    }
  });

  it('a lone quote typed after the last item adds nothing and drops nothing', () => {
    const { onChange, field } = panel(['Payroll, Larkspur', 'Quill']);
    typeLines(field, [`${field.value}, "`]);
    expect(onChange).toHaveBeenLastCalledWith('clients', ['Payroll, Larkspur', 'Quill']);
  });
});
