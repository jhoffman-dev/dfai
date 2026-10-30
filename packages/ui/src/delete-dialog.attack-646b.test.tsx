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
  it.fails('names a single link in the singular', () => {
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

  it.fails('does not point "These" at nothing when a folder holds only links', () => {
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
});
