// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createVaultPath } from '@dfai/domain';
import type { QueryViewState } from '../query/use-query-view.ts';
import { QueryViewBody } from './query-view-body.tsx';

function queryView(edited: boolean): QueryViewState {
  return {
    tabs: [
      {
        path: createVaultPath('.atlas/views/Open work.md'),
        title: 'Open work',
        icon: 'list',
        selected: true,
        virtual: false,
        movable: true,
        deletable: true,
      },
    ],
    panel: {
      composer: {
        mode: 'text',
        onMode: vi.fn(),
        text: 'FROM task GROUP BY status',
        onTextChange: vi.fn(),
        problem: null,
        onRun: vi.fn(),
        builder: null,
        onBuilderChange: vi.fn(),
        textOnly: null,
        choices: { types: [{ value: 'task', label: 'Task' }], fields: [], valueChoices: () => [] },
      },
      layout: 'table',
      layouts: [{ value: 'table', label: 'Table' }],
      onLayout: vi.fn(),
      result: null,
      truncated: false,
      error: null,
      dashboards: { choices: [], notice: null, onAdd: vi.fn() },
    },
    edited,
    save: vi.fn(),
    saveAs: vi.fn(),
    reset: vi.fn(),
    saveError: null,
    suggestedName: 'Open work copy',
  };
}

const notice = () => screen.queryByRole('group', { name: 'Unsaved view changes' });

describe('QueryViewBody', () => {
  it('shows the unsaved-changes notice only while the view differs from its file', () => {
    const { rerender } = render(<QueryViewBody view={queryView(false)} onOpenView={vi.fn()} />);
    expect(notice()).toBeNull();
    rerender(<QueryViewBody view={queryView(true)} onOpenView={vi.fn()} />);
    expect(notice()).not.toBeNull();
  });

  it('puts the notice above the query, as a strip under the tabs (#341)', () => {
    render(<QueryViewBody view={queryView(true)} onOpenView={vi.fn()} />);
    const strip = screen.getByRole('group', { name: 'Unsaved view changes' });
    const query = screen.getByRole('region', { name: 'Query' });
    const tabs = screen.getByRole('button', { name: 'Open work' });
    expect(tabs.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(strip.compareDocumentPosition(query) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });
});
