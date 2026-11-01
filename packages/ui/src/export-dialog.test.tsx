// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ExportDialog, type ExportDialogState } from './export-dialog.tsx';

function draw(state: ExportDialogState = { kind: 'choosing' }) {
  const calls = { onExport: vi.fn(), onClose: vi.fn() };
  render(<ExportDialog subject="Kickoff" state={state} {...calls} />);
  return calls;
}

const exportButton = () => screen.getByRole('button', { name: 'Export…' });

describe('ExportDialog (#501)', () => {
  it('offers only the formats it is handed, Markdown chosen first (#657)', () => {
    const calls = { onExport: vi.fn(), onClose: vi.fn() };
    render(
      <ExportDialog
        subject="Kickoff"
        state={{ kind: 'choosing' }}
        formats={['markdown', 'standalone']}
        {...calls}
      />,
    );
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map((radio) => radio.value)).toEqual(['markdown', 'standalone']);
    expect(radios[0]?.checked).toBe(true);
    expect(screen.queryByRole('radio', { name: /^PDF/ })).toBeNull();
    expect(screen.queryByRole('radio', { name: /^Google Doc/ })).toBeNull();
  });

  it('offers the four formats, Markdown as is first, and exports the one chosen', () => {
    const calls = draw();
    expect(screen.getByRole('dialog', { name: 'Export Kickoff' })).toBeTruthy();
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map((radio) => radio.value)).toEqual([
      'markdown',
      'standalone',
      'pdf',
      'google-doc',
    ]);
    expect(radios[0]?.checked).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: /^PDF/ }));
    fireEvent.click(exportButton());
    expect(calls.onExport).toHaveBeenCalledWith({ format: 'pdf', keepFrontmatter: true });
  });

  it('asks about frontmatter for standalone Markdown alone', () => {
    const calls = draw();
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /Markdown, standalone/ }));
    const keep = screen.getByRole('checkbox', { name: 'Keep the properties as frontmatter' });
    fireEvent.click(keep);
    fireEvent.click(exportButton());
    expect(calls.onExport).toHaveBeenCalledWith({ format: 'standalone', keepFrontmatter: false });
  });

  it('cannot be sent twice, or closed, while the export is being made', () => {
    const calls = draw({ kind: 'working', format: 'google-doc' });
    const button = screen.getByRole('button', { name: 'Exporting…' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/finish signing in in your browser/)).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(calls.onClose).not.toHaveBeenCalled();
  });

  it('says why an export failed, and what to do', () => {
    draw({ kind: 'failed', problem: 'Google is not connected.', fix: 'Connect it in Settings.' });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Google is not connected.');
    expect(alert.textContent).toContain('Connect it in Settings.');
    expect((exportButton() as HTMLButtonElement).disabled).toBe(false);
  });

  it('closes on Cancel', () => {
    const calls = draw();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(calls.onClose).toHaveBeenCalled();
  });
});
