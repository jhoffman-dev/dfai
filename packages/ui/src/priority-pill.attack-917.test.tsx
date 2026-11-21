// @vitest-environment jsdom
/**
 * Adversarial pass on #913 (PR #917): `priority` is a task's, 1 to 4. A note
 * of another type whose own number property is called `priority` — a goal
 * ranked 1 to 10 — keeps the number field it had before tasks had one.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { PropertyDef } from '@dfai/domain';
import { PropertiesPanel } from './properties-panel.tsx';

const GOAL_PRIORITY: PropertyDef = {
  key: 'priority',
  kind: 'number',
  label: 'Priority',
  required: false,
  options: [],
  target: null,
  many: false,
};

describe('a `priority` number on a note that is not a task', () => {
  it('is still a number field, so a goal ranked 7 can be ranked 8', () => {
    render(
      <PropertiesPanel
        typeName="goal"
        rows={[{ def: GOAL_PRIORITY, value: 7, error: null }]}
        relationChoices={{}}
        onChange={vi.fn()}
      />,
    );
    const field = screen.getByLabelText('Priority') as HTMLInputElement;
    expect(field.tagName).toBe('INPUT');
    expect(field.type).toBe('number');
  });
});
