// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createVaultPath, NO_LINKS } from '@dfai/domain';
import { NoteLinksPanel } from './note-links.tsx';
import type { RelatedPanel, RelatedPanelState } from './related-notes.tsx';

const garden = createVaultPath('Home/Garden.md');
const honey = createVaultPath('Home/Honey.md');

function panel(overrides: Partial<RelatedPanel> = {}): RelatedPanel {
  return {
    open: true,
    onToggle: vi.fn(),
    state: {
      kind: 'ready',
      notes: [
        { path: garden, title: 'Garden' },
        { path: honey, title: 'Honey' },
      ],
    },
    onAccept: vi.fn(),
    onDismiss: vi.fn(),
    onStartTrail: vi.fn(),
    ...overrides,
  };
}

function renderFoot(related: RelatedPanel | undefined, onOpen = vi.fn()) {
  render(
    <NoteLinksPanel
      links={NO_LINKS}
      onOpen={onOpen}
      mentions={{ kind: 'idle' }}
      onFindMentions={() => {}}
      onLinkMention={() => {}}
      {...(related !== undefined && { related })}
    />,
  );
  return { onOpen };
}

describe('the Related notes section', () => {
  it('is not drawn where the page offers no related notes', () => {
    renderFoot(undefined);
    expect(screen.getByRole('region', { name: 'Links' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Related notes' })).toBeNull();
  });

  it('shows only its toggle while closed, and asks to open when clicked', async () => {
    const related = panel({ open: false });
    renderFoot(related);
    const toggle = screen.getByRole('button', { name: 'Related notes' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('list', { name: 'Related notes' })).toBeNull();
    await userEvent.click(toggle);
    expect(related.onToggle).toHaveBeenCalledOnce();
  });

  it('lists each note offered, opening it, linking it or dismissing it', async () => {
    const related = panel();
    const { onOpen } = renderFoot(related);
    const list = screen.getByRole('list', { name: 'Related notes' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);

    await userEvent.click(within(list).getByRole('button', { name: /^Garden/ }));
    expect(onOpen).toHaveBeenCalledWith(garden);
    await userEvent.click(screen.getByRole('button', { name: 'Link Honey from this note' }));
    expect(related.onAccept).toHaveBeenCalledWith(honey);
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss Garden' }));
    expect(related.onDismiss).toHaveBeenCalledWith(garden);
    expect(related.onAccept).toHaveBeenCalledOnce();
  });

  it('says why a link failed on that row alone, keeping the rest listed', () => {
    renderFoot(
      panel({
        state: {
          kind: 'ready',
          notes: [
            { path: garden, title: 'Garden', problem: 'Plan changed on disk. Try again.' },
            { path: honey, title: 'Honey' },
          ],
        },
      }),
    );
    const rows = within(screen.getByRole('list', { name: 'Related notes' })).getAllByRole(
      'listitem',
    );
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByRole('alert').textContent).toBe(
      'Plan changed on disk. Try again.',
    );
    expect(within(rows[1]!).queryByRole('alert')).toBeNull();
  });

  it('starts a trail from the note', async () => {
    const related = panel();
    renderFoot(related);
    await userEvent.click(screen.getByRole('button', { name: 'Walk a trail from here' }));
    expect(related.onStartTrail).toHaveBeenCalledOnce();
  });

  it.each<[RelatedPanelState, RegExp]>([
    [{ kind: 'loading' }, /Looking/],
    [{ kind: 'off' }, /Turn on “By meaning” in ⌘K/],
    [{ kind: 'unavailable' }, /not available here/],
    [{ kind: 'not-built', done: 12, total: 40 }, /12 of 40 notes/],
    [{ kind: 'not-built', done: 40, total: 40 }, /nothing to compare by meaning yet/],
    [{ kind: 'ready', notes: [] }, /Nothing else is close in meaning/],
  ])('says where it has got to when there is nothing to list: %o', (state, said) => {
    renderFoot(panel({ state }));
    const section = screen.getByRole('region', { name: 'Related notes' });
    expect(within(section).getByText(said)).toBeTruthy();
    expect(within(section).queryByRole('button', { name: /^Link / })).toBeNull();
  });

  it('says why it failed as an alert', () => {
    renderFoot(panel({ state: { kind: 'failed', message: 'The note changed on disk' } }));
    expect(screen.getByRole('alert').textContent).toBe('The note changed on disk');
  });
});
