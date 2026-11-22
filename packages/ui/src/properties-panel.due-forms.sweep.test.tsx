// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { dueOf, type PropertyDef } from '@dfai/domain';
import { DUE_FORMS } from '@dfai/domain/testing';
import { PropertiesPanel, type PropertyRow } from './properties-panel.tsx';

/**
 * #928, PR #930 review: every written form of a task's due in the properties
 * panel, its row as the shell hands it (`useNoteProperties`: the due as read,
 * and a time field where it holds a day) — the day shown, a time only when it
 * has one, and as written when it is no due.
 */
const DUE: PropertyDef = {
  key: 'due',
  label: 'Due',
  kind: 'date',
  required: false,
  options: [],
  target: null,
  many: false,
};

describe('the properties panel', () => {
  it.each(DUE_FORMS)('shows $form on its day, with a time only when it has one', (form) => {
    const due = dueOf(form.written);
    const row: PropertyRow = {
      def: DUE,
      value: form.written,
      error: null,
      due,
      ...(due !== null && { editor: 'dueTime' }),
    };
    render(
      <PropertiesPanel typeName="task" rows={[row]} relationChoices={{}} onChange={vi.fn()} />,
    );
    const shown = document.querySelector('.props__date-text')?.textContent;
    const time = screen.queryByLabelText('Due time') as HTMLInputElement | null;
    if (form.day === null) {
      expect(shown).toBe(form.written);
      expect(time).toBeNull();
    } else {
      expect(shown).toBe(
        form.time === null ? 'Fri, Dec 4, 2026' : `Fri, Dec 4, 2026, ${form.time}`,
      );
      expect(time?.value).toBe(form.time ?? '');
    }
    cleanup();
  });

  /** Each form given the next day in its date field: its time kept as written; one the due rules read as no time dropped. */
  const ON_NEXT_DAY: Readonly<Record<string, string>> = {
    'a day': '2026-12-05',
    'T15:30': '2026-12-05T15:30',
    'a space': '2026-12-05 15:30',
    seconds: '2026-12-05T15:30:59',
    'a zone': '2026-12-05T15:30Z',
    'T24:00': '2026-12-05',
    'T23:60': '2026-12-05',
    'T15:3': '2026-12-05',
    'a bare T': '2026-12-05',
  };

  it.each(DUE_FORMS)('writes $form on the next day when its date is changed', (form) => {
    const due = dueOf(form.written);
    const onChange = vi.fn();
    const row: PropertyRow = {
      def: DUE,
      value: form.written,
      error: null,
      due,
      ...(due !== null && { editor: 'dueTime' }),
    };
    render(
      <PropertiesPanel typeName="task" rows={[row]} relationChoices={{}} onChange={onChange} />,
    );
    const field = screen.getByLabelText('Due');
    fireEvent.change(field, { target: { value: '2026-12-05' } });
    fireEvent.blur(field);
    expect(onChange).toHaveBeenLastCalledWith('due', ON_NEXT_DAY[form.form]);
    cleanup();
  });
});
