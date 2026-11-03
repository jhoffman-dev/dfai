// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { UpdateReadyBar } from './update-ready.tsx';

describe('the Update ready bar (#668)', () => {
  it('says an update is ready, as a status, and reloads on its one button', () => {
    const onReload = vi.fn();
    render(<UpdateReadyBar onReload={onReload} />);
    expect(screen.getByRole('status').textContent).toContain('Update ready');
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });
});
