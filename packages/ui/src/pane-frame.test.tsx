// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PaneFrame } from './pane-frame.tsx';

function show(overrides: Partial<Parameters<typeof PaneFrame>[0]> = {}) {
  const props = {
    label: 'Pane 1',
    focused: false,
    onFocus: () => {},
    children: <button type="button">Inside the pane</button>,
    ...overrides,
  };
  return { ...render(<PaneFrame {...props} />), props };
}

const pane = (name: string) => screen.getByRole('region', { name });

describe('PaneFrame', () => {
  it('is a named region, so a split window has two places a reader can go', () => {
    show();
    expect(pane('Pane 1')).toBeDefined();
  });

  it('keeps a hidden pane mounted, out of sight and out of the reading order (#658)', () => {
    show({ hidden: true });
    expect(screen.queryByRole('region', { name: 'Pane 1' })).toBeNull();
    const kept = screen.getByRole('button', { name: 'Inside the pane', hidden: true });
    expect(kept.closest('section')?.hidden).toBe(true);
  });

  it('draws no hidden attribute on a shown pane', () => {
    show();
    expect(pane('Pane 1').hasAttribute('hidden')).toBe(false);
  });

  it('takes the focus when anything inside it is clicked', async () => {
    const onFocus = vi.fn();
    show({ onFocus });

    await userEvent.click(screen.getByRole('button', { name: 'Inside the pane' }));

    expect(onFocus).toHaveBeenCalled();
  });

  it('takes the focus when the pane itself is clicked, not only its contents', async () => {
    const onFocus = vi.fn();
    show({ onFocus });

    await userEvent.click(pane('Pane 1'));

    expect(onFocus).toHaveBeenCalled();
  });

  it('takes the focus when something inside it is tabbed to, without a click', () => {
    const onFocus = vi.fn();
    show({ onFocus });

    screen.getByRole('button', { name: 'Inside the pane' }).focus();

    expect(onFocus).toHaveBeenCalled();
  });

  it('says which pane the next note will open in', () => {
    show({ focused: true });
    expect(pane('Pane 1').className).toContain('pane--focused');
  });

  it('does not say so when it is the other pane', () => {
    show({ focused: false });
    expect(pane('Pane 1').className).not.toContain('pane--focused');
  });
});

describe('the pane focus a frame hands down', () => {
  it('names the close shortcut on the focused pane’s Close alone', async () => {
    const { PageBar } = await import('./page-bar.tsx');
    const crumb = { icon: 'doc', parent: 'Pages' } as const;
    render(
      <>
        <PaneFrame label="Pane 1" focused onFocus={() => {}}>
          <PageBar crumb={crumb} name="alpha" onClose={() => {}} />
        </PaneFrame>
        <PaneFrame label="Pane 2" focused={false} onFocus={() => {}}>
          <PageBar crumb={crumb} name="beta" onClose={() => {}} />
        </PaneFrame>
      </>,
    );
    const titles = screen
      .getAllByRole('button', { name: 'Close pane' })
      .map((button) => button.getAttribute('title'));
    expect(titles).toEqual(['Close pane (⇧⌘\\)', 'Close pane']);
  });
});
