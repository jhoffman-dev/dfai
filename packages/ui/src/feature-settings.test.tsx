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

  it('holds the switches until the settings are read', () => {
    renderWith([READING], { ready: false });
    expect(screen.getByRole('switch', { name: 'Reading' }).hasAttribute('disabled')).toBe(true);
  });

  it('holds a feature off, and says why, while what it needs is off', () => {
    renderWith([
      { ...READING, on: false },
      { id: 'kindle', label: 'Kindle', summary: 'Kindle highlights.', on: false, needs: 'Reading' },
    ]);
    expect(screen.getByRole('switch', { name: 'Kindle' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('switch', { name: 'Kindle' }).getAttribute('aria-checked')).toBe(
      'false',
    );
    expect(screen.getByRole('switch', { name: 'Reading' }).hasAttribute('disabled')).toBe(false);
    expect(within(card()).getByText('Kindle highlights. Needs Reading.')).toBeTruthy();
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
