// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VaultEmptyState } from './vault-empty.tsx';

describe('VaultEmptyState', () => {
  it('asks the user to choose a folder', () => {
    render(<VaultEmptyState onChooseVault={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Open a vault' })).toBeDefined();
  });

  it('calls back when the button is pressed', async () => {
    const onChooseVault = vi.fn();
    render(<VaultEmptyState onChooseVault={onChooseVault} />);
    await userEvent.click(screen.getByRole('button', { name: 'Choose folder…' }));
    expect(onChooseVault).toHaveBeenCalledOnce();
  });

  it('offers no folder where a folder cannot be opened as the vault (#657)', () => {
    render(<VaultEmptyState />);
    expect(screen.getByRole('heading', { name: 'Open a vault' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Choose folder…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open a vault from GitHub…' })).toBeNull();
  });
});
