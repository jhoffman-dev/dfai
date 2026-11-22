// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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
});
