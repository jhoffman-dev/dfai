// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FeatureSettings, type FeatureRow } from './feature-settings.tsx';
import { FeatureOffNotice } from './feature-off-notice.tsx';

const READING: FeatureRow = {
  id: 'reading',
  label: 'Reading',
  summary: 'PDFs and EPUBs in the reader.',
  on: true,
  needs: null,
};

function renderWith(
  rows: readonly FeatureRow[],
  { ready = true, problem = null as string | null } = {},
) {
  const onSwitch = vi.fn();
  render(<FeatureSettings rows={rows} ready={ready} problem={problem} onSwitch={onSwitch} />);
  return onSwitch;
}

const card = () => screen.getByRole('region', { name: 'Features' });

describe('FeatureSettings', () => {
  it('lists each feature with its line and a switch named after it', () => {
    renderWith([READING]);
    expect(within(card()).getByText('PDFs and EPUBs in the reader.')).toBeTruthy();
    const toggle = within(card()).getByRole('switch', { name: 'Reading' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('switches a feature off and on, from the keyboard as from a click', async () => {
    const onSwitch = renderWith([READING]);
    await userEvent.click(screen.getByRole('switch', { name: 'Reading' }));
    expect(onSwitch).toHaveBeenLastCalledWith({ id: 'reading', on: false });

    onSwitch.mockClear();
    render(
      <FeatureSettings
        rows={[{ ...READING, id: 'maps', label: 'Maps', on: false }]}
        ready
        problem={null}
        onSwitch={onSwitch}
      />,
    );
    screen.getByRole('switch', { name: 'Maps' }).focus();
    await userEvent.keyboard(' ');
    expect(onSwitch).toHaveBeenLastCalledWith({ id: 'maps', on: true });
  });

  it('holds the switches until the settings are read: reachable, and pressing writes nothing', async () => {
    const onSwitch = renderWith([READING], { ready: false });
    const toggle = screen.getByRole('switch', { name: 'Reading' });
    expect(toggle.getAttribute('aria-disabled')).toBe('true');
    await userEvent.click(toggle);
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it('says "Loading…" while the settings are unread, and each held switch points at it', () => {
    renderWith(
      [
        { ...READING, on: false },
        {
          id: 'kindle',
          label: 'Kindle',
          summary: 'Kindle highlights.',
          on: false,
          needs: 'Reading',
        },
      ],
      { ready: false },
    );
    expect(within(card()).getByRole('status').textContent).toBe('Loading…');
    expect(screen.getByRole('switch', { name: 'Reading', description: 'Loading…' })).toBeTruthy();
    expect(
      screen.getByRole('switch', { name: 'Kindle', description: 'Loading… Needs Reading.' }),
    ).toBeTruthy();
  });

  it('drops "Loading…" once the settings are read', () => {
    renderWith([READING]);
    expect(within(card()).queryByRole('status')).toBeNull();
    expect(screen.getByRole('switch', { name: 'Reading' }).hasAttribute('aria-describedby')).toBe(
      false,
    );
  });

  it('holds a feature off, and says why, while what it needs is off', () => {
    renderWith([
      { ...READING, on: false },
      { id: 'kindle', label: 'Kindle', summary: 'Kindle highlights.', on: false, needs: 'Reading' },
    ]);
    const kindle = screen.getByRole('switch', { name: 'Kindle' });
    expect(kindle.getAttribute('aria-disabled')).toBe('true');
    expect(kindle.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('switch', { name: 'Reading' }).getAttribute('aria-disabled')).toBe(
      'false',
    );
    const reason = within(card()).getByText('Needs Reading.');
    expect(reason.parentElement?.textContent).toBe('Kindle highlights. Needs Reading.');
  });

  it('keeps a held switch in the Tab order, says why it is held, and writes nothing when pressed', async () => {
    const onSwitch = renderWith([
      { ...READING, on: false },
      { id: 'kindle', label: 'Kindle', summary: 'Kindle highlights.', on: false, needs: 'Reading' },
    ]);
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('switch', { name: 'Reading' }));
    await userEvent.tab();
    const kindle = screen.getByRole('switch', { name: 'Kindle', description: 'Needs Reading.' });
    expect(document.activeElement).toBe(kindle);
    await userEvent.keyboard(' ');
    await userEvent.keyboard('{Enter}');
    await userEvent.click(kindle);
    expect(onSwitch).not.toHaveBeenCalled();
    // A switch nothing holds has no description to read.
    expect(screen.getByRole('switch', { name: 'Reading' }).hasAttribute('aria-describedby')).toBe(
      false,
    );
  });

  it('says why a switch was not saved', () => {
    renderWith([READING], { problem: 'The disk is full.' });
    expect(screen.getByRole('alert').textContent).toBe('The disk is full.');
  });
});

describe('FeatureOffNotice', () => {
  it('says the feature is off, and leads to Settings to turn it on', async () => {
    const onTurnOn = vi.fn();
    render(<FeatureOffNotice label="Reading" onTurnOn={onTurnOn} />);
    expect(screen.getByRole('status').textContent).toContain('Reading is turned off');
    await userEvent.click(screen.getByRole('button', { name: 'Turn on in Settings' }));
    expect(onTurnOn).toHaveBeenCalledOnce();
  });
});
