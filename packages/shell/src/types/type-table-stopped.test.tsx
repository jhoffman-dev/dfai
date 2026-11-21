// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { parseObjectType, QUERY_STOPPED_WORDS } from '@dfai/domain';
import { fakeIndexPort, fakeVaultFs, recordingActivity, type IndexPort } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { TableView } from '@dfai/ui';
import { useTypeTable } from './use-type-table.ts';
import type { OpenEditors } from '../panes/open-editors.ts';

/**
 * #919: a type's table the index stopped at its step budget said only
 * "interrupted". It says what happened and what to do instead.
 */

const TYPES = [parseObjectType({ name: 'meeting', properties: { date: 'date' } })];

const EDITORS: OpenEditors = {
  register: () => {},
  setPropertiesIfOpen: async () => false,
  savePane: () => {},
  reloadOthers: () => {},
};

function MeetingTable({ index }: { index: IndexPort }) {
  const table = useTypeTable({
    fs: fakeVaultFs(),
    markdown: remarkMarkdown,
    index,
    types: TYPES,
    typeName: 'meeting',
    indexKey: 'ready:1',
    onChanged: () => {},
    editors: EDITORS,
    activity: recordingActivity(),
  });
  return (
    <TableView
      result={table.result}
      sorts={table.sorts}
      error={table.error}
      schema={{ kinds: { date: 'date' }, labels: {}, noun: 'meeting' }}
      onOpenNote={() => {}}
      onEditCell={() => {}}
      onToggleSort={() => {}}
      onNewNote={() => {}}
    />
  );
}

describe('a type table the index stopped', () => {
  // The desktop host rejects with SQLite's word as a string; the web host throws it as an Error.
  it.each([
    ['the desktop host', () => Promise.reject('interrupted')],
    ['the web host', () => Promise.reject(new Error('interrupted'))],
  ])('says so in plain words, from %s', async (_host, query) => {
    render(<MeetingTable index={fakeIndexPort({ query })} />);

    expect((await screen.findByRole('alert')).textContent).toBe(QUERY_STOPPED_WORDS);
    expect(screen.queryByText('interrupted')).toBeNull();
  });

  it('shows any other failure as the index said it', async () => {
    const query = () => Promise.reject(new Error('no such table: v_meeting'));
    render(<MeetingTable index={fakeIndexPort({ query })} />);

    expect((await screen.findByRole('alert')).textContent).toBe('no such table: v_meeting');
  });
});
