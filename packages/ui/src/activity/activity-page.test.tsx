// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ActivityPage, type ActivityPageProps, type ActivityRowView } from './activity-page.tsx';

const ROWS: ActivityRowView[] = [
  {
    id: '3',
    time: 'Today 14:03',
    dateTime: '2026-09-28T14:03:00',
    level: 'error',
    kind: 'source',
    message: 'GitHub issues: Refresh failed. HTTP 500',
    subject: 'GitHub issues',
  },
  {
    id: '2',
    time: 'Today 13:00',
    dateTime: '2026-09-28T13:00:00',
    level: 'warning',
    kind: 'api',
    message: 'PUT v1/notes/{path}/body refused for Call (conflict).',
    subject: null,
  },
  {
    id: '1',
    time: 'Yesterday 03:00',
    dateTime: '2026-09-27T03:00:00',
    level: 'info',
    kind: 'automation',
    message: 'Tidy tasks: Ran on schedule. Archived 2 notes.',
    subject: 'Tidy tasks',
  },
];

function page(props: Partial<ActivityPageProps> = {}) {
  const handlers = {
    onLevel: vi.fn(),
    onToggleKind: vi.fn(),
    onText: vi.fn(),
    onOpenSubject: vi.fn(),
    onCopy: vi.fn(() => Promise.resolve()),
  };
  render(
    <ActivityPage
      rows={ROWS}
      total={ROWS.length}
      error={null}
      level="all"
      kinds={[]}
      text=""
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

const lines = () =>
  within(screen.getByRole('list', { name: 'Activity lines' })).getAllByRole('listitem');

describe('ActivityPage', () => {
  it('shows each line with its time, level, kind and message, in the order given', () => {
    page();
    const shown = lines();
    expect(shown).toHaveLength(3);
    expect(shown[0]?.textContent).toContain('Today 14:03');
    expect(shown[0]?.textContent).toContain('Error');
    expect(shown[0]?.textContent).toContain('Sources');
    expect(shown[0]?.textContent).toContain('GitHub issues: Refresh failed. HTTP 500');
    expect(shown[1]?.textContent).toContain('Warning');
    expect(shown[1]?.textContent).toContain('API & MCP');
    expect(shown[2]?.textContent).toContain('Yesterday 03:00');
    expect(
      within(shown[0] as HTMLElement)
        .getByText('Today 14:03')
        .getAttribute('datetime'),
    ).toBe('2026-09-28T14:03:00');
  });

  it('opens what a line is about, and offers no link for a line about nothing', async () => {
    const { onOpenSubject } = page();
    const shown = lines();
    await userEvent.click(
      within(shown[2] as HTMLElement).getByRole('button', { name: 'Open Tidy tasks' }),
    );
    expect(onOpenSubject).toHaveBeenCalledWith('1');
    expect(within(shown[0] as HTMLElement).getByRole('button').textContent).toBe(
      'Open GitHub issues',
    );
    expect(within(shown[1] as HTMLElement).queryByRole('button')).toBeNull();
  });

  it('changes the level with the arrow keys, as one radio group', async () => {
    const { onLevel } = page();
    const everything = screen.getByRole('radio', { name: 'Everything' });
    expect(everything.getAttribute('aria-checked')).toBe('true');
    everything.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onLevel).toHaveBeenCalledWith('warnings');
    await userEvent.click(screen.getByRole('radio', { name: 'Errors only' }));
    expect(onLevel).toHaveBeenLastCalledWith('errors');
  });

  it('marks the level chosen', () => {
    page({ level: 'errors' });
    expect(screen.getByRole('radio', { name: 'Errors only' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(screen.getByRole('radio', { name: 'Everything' }).getAttribute('aria-checked')).toBe(
      'false',
    );
  });

  it('offers every kind as a toggle, pressed when chosen', async () => {
    const { onToggleKind } = page({ kinds: ['chat'] });
    const kinds = within(screen.getByRole('group', { name: 'Kinds' })).getAllByRole('button');
    expect(kinds.map((kind) => kind.textContent)).toEqual([
      'Automations',
      'Sources',
      'Meetings',
      'API & MCP',
      'Claude',
      'Index',
      'Saves',
      'Exports',
      'Sync',
      'App',
    ]);
    expect(screen.getByRole('button', { name: 'Claude' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByRole('button', { name: 'Index' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Saves' }));
    expect(onToggleKind).toHaveBeenCalledWith('save');
  });

  it('searches as the words are typed', async () => {
    const { onText } = page();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search activity' }), 'x');
    expect(onText).toHaveBeenCalledWith('x');
  });

  it('says so when the log is empty', () => {
    page({ rows: [], total: 0 });
    expect(screen.getByText(/^Nothing yet\./)).toBeTruthy();
    expect(document.querySelector('.page-bar__count')).toBeNull();
  });

  it('counts the lines and says how long they are kept, beside the page name', () => {
    page({ rows: [], total: 3 });
    expect(screen.getByText('3 lines · kept 30 days').closest('.page-bar__count')).not.toBeNull();
  });

  it('says nothing matches when the filters leave no lines', () => {
    page({ rows: [], total: 3 });
    expect(screen.getByText('No lines match.')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Activity lines' })).toBeNull();
  });

  it('shows why the log could not be read', () => {
    page({ error: 'The Activity log could not be read: denied' });
    expect(screen.getByRole('alert')?.textContent).toContain('denied');
  });

  it('says it is reading until the lines arrive', () => {
    page({ rows: null });
    expect(screen.getByText('Reading the log…')).toBeTruthy();
  });

  it('keeps each line to one row, so the whole message is on its title (13b)', () => {
    page();
    const message = screen.getByText('PUT v1/notes/{path}/body refused for Call (conflict).');
    expect(message.getAttribute('title')).toBe(
      'PUT v1/notes/{path}/body refused for Call (conflict).',
    );
  });

  it('gives the whole of “Open …” on the button’s title, since a narrow row caps it (13b review)', () => {
    page();
    const open = screen.getByRole('button', { name: 'Open Tidy tasks' });
    expect(open.getAttribute('title')).toBe('Open Tidy tasks');
  });

  it('draws each kind filter as a ghost control that reads as pressed while chosen (13b)', () => {
    page({ kinds: ['chat'] });
    const chosen = screen.getByRole('button', { name: 'Claude' });
    const other = screen.getByRole('button', { name: 'Index' });
    expect(chosen.className.split(' ')).toContain('btn--ghost');
    expect(chosen.getAttribute('aria-pressed')).toBe('true');
    expect(other.getAttribute('aria-pressed')).toBe('false');
  });
});
