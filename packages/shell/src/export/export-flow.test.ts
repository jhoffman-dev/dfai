import { describe, expect, it, vi } from 'vitest';
import { GOOGLE_CALENDAR_SCOPES, type VaultPath } from '@dfai/domain';
import {
  fakeGoogleCalendar,
  fakeGoogleDrive,
  fakeIndexPort,
  fakePdfRenderer,
  readOnlyVault,
  recordingExportFiles,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { createExportStore, exportCommands, type ExportDeps } from './export-flow.ts';

const KICKOFF = 'Kickoff.md' as VaultPath;
const RETRO = 'Retro.md' as VaultPath;
const VAULT = '/Users/someone/Vault';

function setUp(picked: { path: string } | null = { path: '/Exports/Kickoff.md' }) {
  const files = recordingExportFiles(picked);
  const google = fakeGoogleCalendar();
  const drive = fakeGoogleDrive();
  const deps: ExportDeps = {
    ports: {
      fs: readOnlyVault({ 'Kickoff.md': 'Agreed.\n', 'Retro.md': 'Went well.\n' }),
      markdown: remarkMarkdown,
      index: fakeIndexPort(),
      files: files.port,
      pdf: fakePdfRenderer(),
      renderer: { bodyHtml: () => '<p>body</p>', styles: '' },
      clock: { today: () => '2026-10-21', now: () => 0, localNow: () => '2026-10-21T09:00:00' },
      google: google.port,
      drive: drive.port,
      wait: async () => {},
    },
    vault: VAULT,
    appName: 'Northwind',
    notePaths: [KICKOFF, RETRO],
    overlay: { show: vi.fn(), hide: vi.fn() },
    toasts: { show: vi.fn(() => 1) },
    activity: { record: vi.fn() },
    openActivity: vi.fn(),
    openLink: vi.fn(),
  };
  const store = createExportStore();
  const commands = exportCommands(store, () => deps);
  const settled = () => expect.poll(() => store.getState().flow?.state.kind ?? 'closed');
  return { store, commands, deps, files: files.state, google, drive: drive.state, settled };
}

describe('the export flow (#501)', () => {
  it('asks how, saves, then says where it went in a toast and in Activity', async () => {
    const { store, commands, deps, files, settled } = setUp();
    commands.ask([KICKOFF]);
    expect(deps.overlay.show).toHaveBeenCalledWith('export-notes');
    expect(store.getState().flow).toMatchObject({
      subject: 'Kickoff',
      state: { kind: 'choosing' },
    });

    commands.run({ format: 'markdown', keepFrontmatter: true });
    expect(store.getState().flow?.state).toEqual({ kind: 'working', format: 'markdown' });
    await settled().toBe('closed');

    expect(files.written.get('')).toEqual(new TextEncoder().encode('Agreed.\n'));
    const said = 'Exported 1 note as Markdown to /Exports/Kickoff.md.';
    expect(deps.activity.record).toHaveBeenCalledWith({
      level: 'info',
      kind: 'export',
      message: said,
      subject: { kind: 'note', path: KICKOFF },
    });
    expect(deps.toasts.show).toHaveBeenCalledWith(
      expect.objectContaining({
        message: said,
        action: expect.objectContaining({ label: 'Activity' }),
      }),
    );
    expect(deps.overlay.hide).toHaveBeenCalledWith('export-notes');
  });

  it('goes back to the question, saying nothing, when the save dialog is cancelled', async () => {
    const { store, commands, deps, settled } = setUp(null);
    commands.ask([KICKOFF]);
    commands.run({ format: 'pdf', keepFrontmatter: true });
    await settled().toBe('choosing');
    expect(store.getState().flow).not.toBeNull();
    expect(deps.toasts.show).not.toHaveBeenCalled();
    expect(deps.activity.record).not.toHaveBeenCalled();
  });

  it('says what went wrong and keeps the question open', async () => {
    const { store, commands, deps, files, settled } = setUp();
    files.failWrite = new Error('cannot write /Exports/Kickoff.md: Permission denied');
    commands.ask([KICKOFF]);
    commands.run({ format: 'markdown', keepFrontmatter: true });
    await settled().toBe('failed');
    expect(store.getState().flow?.state).toEqual({
      kind: 'failed',
      problem: 'The export could not be made: cannot write /Exports/Kickoff.md: Permission denied',
      fix: null,
    });
    // Kept in Activity too (#502), and what it made taken back.
    expect(deps.activity.record).toHaveBeenCalledWith({
      level: 'error',
      kind: 'export',
      message: 'The export could not be made: cannot write /Exports/Kickoff.md: Permission denied',
      subject: { kind: 'note', path: KICKOFF },
    });
    expect(files.discarded).toBe(1);
  });

  it('explains a Google sign-in problem in Google’s words, with the fix', async () => {
    const { store, commands, settled } = setUp();
    commands.ask([KICKOFF]);
    commands.run({ format: 'google-doc', keepFrontmatter: true });
    await settled().toBe('failed');
    expect(store.getState().flow?.state).toMatchObject({
      kind: 'failed',
      problem: expect.stringContaining('Settings → Google Calendar'),
    });
  });

  it('offers to open one Google Doc made, from the toast', async () => {
    const { commands, deps, google, settled } = setUp();
    await google.port.connect({
      vault: VAULT,
      clientId: '1234-abc.apps.googleusercontent.com',
      scopes: GOOGLE_CALENDAR_SCOPES,
    });
    commands.ask([KICKOFF]);
    commands.run({ format: 'google-doc', keepFrontmatter: true });
    await settled().toBe('closed');
    const shown = vi.mocked(deps.toasts.show).mock.calls[0]?.[0];
    expect(shown?.action?.label).toBe('Open in Google Docs');
    shown?.action?.onClick();
    expect(deps.openLink).toHaveBeenCalledWith('https://docs.example.com/document/d/doc-1/edit');
  });

  it('tells the table its rows were exported, or chooses them again when closed', async () => {
    const { commands, settled } = setUp({ path: '/Exports/Exported notes 2026-10-21' });
    const done = vi.fn();
    commands.ask([KICKOFF, RETRO, KICKOFF], done);
    commands.run({ format: 'standalone', keepFrontmatter: false });
    await settled().toBe('closed');
    expect(done).toHaveBeenCalledWith({ answered: [KICKOFF, RETRO], failed: [] });

    const left = vi.fn();
    commands.ask([RETRO], left);
    commands.close();
    expect(left).toHaveBeenCalledWith({ answered: [], failed: [RETRO] });
  });

  it('is not closed while the export is being made', () => {
    const { store, commands } = setUp();
    commands.ask([KICKOFF]);
    commands.run({ format: 'pdf', keepFrontmatter: true });
    commands.close();
    expect(store.getState().flow).not.toBeNull();
  });

  it('lists the Google Docs made before one failed, and offers the first (#502)', async () => {
    const { commands, deps, google, drive, settled } = setUp();
    await google.port.connect({
      vault: VAULT,
      clientId: '1234-abc.apps.googleusercontent.com',
      scopes: GOOGLE_CALENDAR_SCOPES,
    });
    drive.uploadFailures.push(undefined, new Error('Google is offline'));
    commands.ask([KICKOFF, RETRO]);
    commands.run({ format: 'google-doc', keepFrontmatter: true });
    await settled().toBe('failed');
    const url = 'https://docs.example.com/document/d/doc-1/edit';
    expect(deps.activity.record).toHaveBeenCalledWith({
      level: 'info',
      kind: 'export',
      message: `Made the Google Doc “Kickoff”: ${url}`,
      subject: null,
    });
    const shown = vi.mocked(deps.toasts.show).mock.calls[0]?.[0];
    expect(shown?.message).toBe(
      'Made 1 of 2 Google Docs in “Northwind exports” before it stopped: Google is offline',
    );
    shown?.action?.onClick();
    expect(deps.openLink).toHaveBeenCalledWith(url);
  });
});
