// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PropertyDef } from '@dfai/domain';
import { PropertiesPanel, type PropertyRow } from './properties-panel.tsx';

/** #928: a task's due, a date with an optional time of day, in the properties panel. */
const DUE: PropertyDef = {
  key: 'due',
  label: 'Due',
  kind: 'date',
  required: false,
  options: [],
  target: null,
  many: false,
};

const dueRow = (value: unknown, editor: PropertyRow['editor'] = 'dueTime'): PropertyRow => ({
  def: DUE,
  value,
  error: null,
  ...(editor !== undefined && { editor }),
});

const panel = (row: PropertyRow) => {
  const onChange = vi.fn();
  render(<PropertiesPanel typeName="task" rows={[row]} relationChoices={{}} onChange={onChange} />);
  return onChange;
};

const timeField = () => screen.getByLabelText('Due time');

describe('the due’s time in the properties panel (#928)', () => {
  it('offers an empty time beside a date-only due, and writes nothing until one is set', () => {
    const onChange = panel(dueRow('2026-12-04'));
    expect(timeField().getAttribute('type')).toBe('time');
    expect((timeField() as HTMLInputElement).value).toBe('');
    fireEvent.blur(timeField());
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Clear time of Due' })).toBeNull();
  });

  it('writes the day with the time set, when the field is left', () => {
    const onChange = panel(dueRow('2026-12-04'));
    fireEvent.change(timeField(), { target: { value: '15:30' } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(timeField());
    expect(onChange).toHaveBeenLastCalledWith('due', '2026-12-04T15:30');
  });

  it('writes on Enter, and Escape puts the time back unwritten', () => {
    const onChange = panel(dueRow('2026-12-04T15:30'));
    expect((timeField() as HTMLInputElement).value).toBe('15:30');
    fireEvent.change(timeField(), { target: { value: '09:05' } });
    fireEvent.keyDown(timeField(), { key: 'Escape' });
    expect((timeField() as HTMLInputElement).value).toBe('15:30');
    fireEvent.change(timeField(), { target: { value: '09:05' } });
    fireEvent.keyDown(timeField(), { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith('due', '2026-12-04T09:05');
  });

  it('writes nothing for a time erased part-way: the time is taken off by its Clear', () => {
    const onChange = panel(dueRow('2026-12-04T15:30'));
    fireEvent.change(timeField(), { target: { value: '' } });
    fireEvent.blur(timeField());
    expect(onChange).not.toHaveBeenCalled();
    expect((timeField() as HTMLInputElement).value).toBe('15:30');
  });

  it('takes the time off and leaves the date, from the keyboard', async () => {
    const onChange = panel(dueRow('2026-12-04T15:30'));
    const clear = screen.getByRole('button', { name: 'Clear time of Due' });
    clear.focus();
    await userEvent.keyboard('{Enter}');
    expect(onChange).toHaveBeenLastCalledWith('due', '2026-12-04');
  });

  it('is reached by Tab from the date field', async () => {
    panel(dueRow('2026-12-04'));
    screen.getByLabelText('Due').focus();
    await userEvent.tab();
    // The date's Clear sits between them: past it is the time.
    if (document.activeElement !== timeField()) await userEvent.tab();
    expect(document.activeElement).toBe(timeField());
  });

  it('keeps the time when only the day is changed', () => {
    const onChange = panel(dueRow('2026-12-04T15:30'));
    fireEvent.change(screen.getByLabelText('Due'), { target: { value: '2026-12-05' } });
    fireEvent.blur(screen.getByLabelText('Due'));
    expect(onChange).toHaveBeenLastCalledWith('due', '2026-12-05T15:30');
  });

  it('offers no time where the caller did not ask for one', () => {
    panel({ def: DUE, value: '2026-12-04', error: null });
    expect(screen.getByLabelText('Due')).toBeDefined();
    expect(screen.queryByLabelText('Due time')).toBeNull();
  });
});
