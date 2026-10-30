import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DeleteDialog, type DeletionSubject } from './delete-dialog.tsx';

/*
 * Attack on PR #646 (a3f555c5): the links sentence is always plural and
 * always hangs off "These", even when there is one link and nothing before it.
 */

const folder: DeletionSubject = {
  name: 'Shelf',
  kind: 'folder',
  notes: 0,
  otherFiles: 0,
  unsaved: [],
};

describe('DeleteDialog links wording (attack 646b)', () => {
  it('names a single link in the singular', () => {
    render(
      <DeleteDialog
        subject={{ ...folder, notes: 2, links: ['garden'] }}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    // Observed: "The 2 notes in it go too. These are links, so only the links go … : garden."
    expect(screen.getByRole('alertdialog').textContent).not.toContain('These are links');
  });

  it('does not point "These" at nothing when a folder holds only links', () => {
    render(
      <DeleteDialog
        subject={{ ...folder, links: ['garden', 'orchard'] }}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    // Observed: "It has no notes in it. These are links, …" — "These" has no antecedent.
    expect(screen.getByRole('alertdialog').textContent).not.toMatch(/no notes in it\. These/);
  });

  it('names one link in the singular, apart from the note that goes', () => {
    render(
      <DeleteDialog
        subject={{ ...folder, notes: 1, links: ['garden'] }}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole('alertdialog').textContent).toContain(
      'The 1 note in it goes too. The link in it, garden, goes as a link: what it points at ' +
        'stays where it is.',
    );
  });

  it('names five links, then how many more', () => {
    const links = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    render(<DeleteDialog subject={{ ...folder, links }} onConfirm={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('alertdialog').textContent).toContain(
      'It has no notes in it. The 7 links in it, a, b, c, d, e and 2 more, go as links: what ' +
        'they point at stays where it is.',
    );
  });

  it('says why a folder reached through a link cannot go, and offers no Move to Trash', () => {
    render(
      <DeleteDialog
        subject={{ ...folder, refusal: 'It is inside “Work/Alias”, which is a link.' }}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert').textContent).toBe(
      'It is inside “Work/Alias”, which is a link.',
    );
    expect(screen.queryByRole('button', { name: 'Move to Trash' })).toBeNull();
  });
});
