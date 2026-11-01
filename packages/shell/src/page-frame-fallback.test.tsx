// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PageFrameFallback } from './page-frame-fallback.tsx';

describe('PageFrameFallback', () => {
  it('keeps the page bar, with Back and Forward working, over an empty body', async () => {
    const onBack = vi.fn();
    const { container } = render(
      <PageFrameFallback history={{ back: 'Today', forward: null, onBack, onForward: vi.fn() }} />,
    );
    expect(screen.getByRole('group', { name: 'History' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /Back/ }));
    expect(onBack).toHaveBeenCalledTimes(1);
    const body = container.querySelector('.panel__body');
    expect(body?.getAttribute('aria-busy')).toBe('true');
    expect(body?.childElementCount).toBe(0);
  });

  it('offers the way back to the sidebar while it is hidden', async () => {
    const onShowSidebar = vi.fn();
    render(<PageFrameFallback onShowSidebar={onShowSidebar} />);
    await userEvent.click(screen.getByRole('button', { name: 'Show sidebar' }));
    expect(onShowSidebar).toHaveBeenCalledTimes(1);
  });

  it('draws no history or sidebar button when the pane has none', () => {
    render(<PageFrameFallback />);
    expect(screen.queryByRole('group', { name: 'History' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show sidebar' })).toBeNull();
  });

  it('holds what it is given in the body, which is then no longer loading', () => {
    const { container } = render(
      <PageFrameFallback>
        <p>Inside</p>
      </PageFrameFallback>,
    );
    const body = container.querySelector('.panel__body');
    expect(body?.textContent).toBe('Inside');
    expect(body?.hasAttribute('aria-busy')).toBe(false);
  });
});
