// @vitest-environment jsdom
import type { ComponentProps } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SettingsDialog } from '@dfai/ui';
import type { SidebarChatProps } from './chat/sidebar-chat.tsx';
import { ChatFailed, PageFailed, PartFailed, SettingsFailed } from './part-failed.tsx';

const outcome = { retrying: false, onRetry: vi.fn(), onReloadWindow: null };

describe('PartFailed', () => {
  it('says the part could not load, and Reload tries again', async () => {
    const onRetry = vi.fn();
    render(<PartFailed {...outcome} onRetry={onRetry} />);
    expect(screen.getByRole('alert').textContent).toContain('This part couldn’t load.');
    await userEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Reload window' })).toBeNull();
  });

  it('cannot be pressed again while it is reloading', () => {
    render(<PartFailed {...outcome} retrying />);
    expect(screen.getByRole('button', { name: 'Reloading…' }).hasAttribute('disabled')).toBe(true);
  });

  it('offers to reload the window, saying unsaved changes might be lost, once offered', async () => {
    const onReloadWindow = vi.fn();
    render(<PartFailed {...outcome} onReloadWindow={onReloadWindow} />);
    expect(screen.getByRole('alert').textContent).toContain('Unsaved changes might be lost.');
    await userEvent.click(screen.getByRole('button', { name: 'Reload window' }));
    expect(onReloadWindow).toHaveBeenCalledTimes(1);
  });
});

describe('PageFailed', () => {
  it('says so inside the page frame, with Back and Forward still working', async () => {
    const onBack = vi.fn();
    const { container } = render(
      <PageFailed
        {...outcome}
        props={{ history: { back: 'Today', forward: null, onBack, onForward: vi.fn() } }}
      />,
    );
    const body = container.querySelector('.panel__body');
    expect(body?.querySelector('[role="alert"]')).not.toBeNull();
    expect(body?.hasAttribute('aria-busy')).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: /Back/ }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe('SettingsFailed', () => {
  const settings = (onClose: () => void) =>
    ({ onClose }) as unknown as ComponentProps<typeof SettingsDialog>;

  it('says so inside Settings’ window, which Escape closes', async () => {
    const onClose = vi.fn();
    render(<SettingsFailed {...outcome} props={settings(onClose)} />);
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    expect(dialog.querySelector('[role="alert"]')).not.toBeNull();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes from its Close button too', async () => {
    const onClose = vi.fn();
    render(<SettingsFailed {...outcome} props={settings(onClose)} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('ChatFailed', () => {
  it('says so in the panel’s place, which its Close still closes', async () => {
    const onClose = vi.fn();
    const props = { actions: { onClose } } as unknown as SidebarChatProps;
    render(<ChatFailed {...outcome} props={props} />);
    const panel = screen.getByRole('complementary', { name: 'Claude' });
    expect(panel.querySelector('[role="alert"]')).not.toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
