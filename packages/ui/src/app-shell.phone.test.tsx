// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AppShell } from './app-shell.tsx';

/**
 * The phone's bar in the shell (#672): under the work when the app hands one
 * in, and nothing at all — no class, no landmark — when it does not, so every
 * other screen is drawn exactly as before.
 */
function shell(bar: React.ReactNode) {
  return render(
    <AppShell
      sidebar={<button type="button">Today</button>}
      panes={<button type="button">In the note</button>}
      drawer={{ open: false, onOpenChange: vi.fn() }}
      bar={bar}
    />,
  );
}

describe('AppShell phone bar', () => {
  it('draws the bar under the work and says so to the stylesheet', () => {
    const { container } = shell(<nav aria-label="Screens">The bar</nav>);
    const root = container.firstElementChild;
    expect(root?.className).toContain('shell--phone');
    expect(root?.className).toContain('shell--compact');
    const bar = screen.getByRole('navigation', { name: 'Screens' });
    const main = container.querySelector('main');
    expect(main).not.toBeNull();
    // Under the work: after the main column, in the shell itself.
    expect(bar.parentElement).toBe(root);
    expect(main?.compareDocumentPosition(bar)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('with no bar, a compact shell is as it was: no bar landmark, no phone class', () => {
    const { container } = shell(null);
    expect(screen.queryByRole('navigation', { name: 'Screens' })).toBeNull();
    expect(container.firstElementChild?.className).not.toContain('shell--phone');
    expect(container.firstElementChild?.className).toContain('shell--compact');
  });
});
