// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  MeetingSetup,
  type MeetingSetupLineView,
  type MeetingSetupProps,
} from './meeting-setup.tsx';

const LINES: readonly MeetingSetupLineView[] = [
  {
    kind: 'rule',
    what: 'The “After a meeting” rule',
    detail: 'prompt: .atlas/prompts/after-a-meeting.md, output: meeting-digest, apply: mine',
    written: true,
  },
  {
    kind: 'prompt',
    what: 'The prompt .atlas/prompts/after-a-meeting.md',
    detail: 'Already there: kept as it is.',
    written: false,
  },
  { kind: 'type', what: 'The Meeting type', detail: 'Gains tasks, decisions.', written: true },
  {
    kind: 'emails',
    what: 'Your email addresses',
    detail: 'Without them, they are matched by your name only.',
    written: true,
  },
];

function props(overrides: Partial<MeetingSetupProps> = {}): MeetingSetupProps {
  return {
    open: false,
    lines: null,
    asksEmails: false,
    emails: '',
    busy: false,
    result: null,
    problem: null,
    onOpen: vi.fn(),
    onEmailsChange: vi.fn(),
    onAccept: vi.fn(),
    onClose: vi.fn(),
    onDismiss: vi.fn(),
    ...overrides,
  };
}

const region = () => screen.getByRole('region', { name: 'Process meetings when they arrive' });

describe('MeetingSetup', () => {
  it('is one line until asked, which previews or is put away', async () => {
    const given = props();
    render(<MeetingSetup {...given} />);
    expect(region().textContent).toContain('Process meetings when they arrive');
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(given.onOpen).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(given.onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Set up' })).toBeNull();
  });

  it('offers no "Not now" where it always stands', () => {
    render(<MeetingSetup {...props({ dismissable: false })} />);
    expect(screen.getByRole('button', { name: 'Preview' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Not now' })).toBeNull();
  });

  it('says it is reading while the preview is worked out', () => {
    render(<MeetingSetup {...props({ open: true })} />);
    expect(screen.getByRole('status').textContent).toContain('Reading');
    expect(screen.queryByRole('button', { name: 'Set up' })).toBeNull();
  });

  it('lists what is written apart from what is skipped, and asks for the emails', async () => {
    const given = props({ open: true, lines: LINES, asksEmails: true });
    render(<MeetingSetup {...given} />);
    const written = within(screen.getByRole('list', { name: 'Written' }));
    expect(written.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      `${LINES[0]?.what}: ${LINES[0]?.detail}`,
      `${LINES[2]?.what}: ${LINES[2]?.detail}`,
    ]);
    const skipped = within(screen.getByRole('list', { name: 'Skipped' }));
    expect(skipped.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      `${LINES[1]?.what}: ${LINES[1]?.detail}`,
    ]);
    expect(region().textContent).toContain('matched by your name only');
    await userEvent.type(screen.getByRole('textbox', { name: 'Your emails' }), 'm');
    expect(given.onEmailsChange).toHaveBeenCalledWith('m');
    await userEvent.click(screen.getByRole('button', { name: 'Set up' }));
    expect(given.onAccept).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(given.onClose).toHaveBeenCalledOnce();
  });

  it('asks for no emails once they are saved', () => {
    render(<MeetingSetup {...props({ open: true, lines: LINES, asksEmails: false })} />);
    expect(screen.getByRole('list', { name: 'Written' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Your emails' })).toBeNull();
  });

  it('with nothing to write, says so and offers only Close', () => {
    const skipped = LINES.map((line) => ({ ...line, written: false }));
    render(<MeetingSetup {...props({ open: true, lines: skipped })} />);
    expect(region().textContent).toContain('set up already');
    expect(screen.queryByRole('button', { name: 'Set up' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
  });

  it('holds its buttons while the yes is written', () => {
    render(<MeetingSetup {...props({ open: true, lines: LINES, busy: true })} />);
    expect((screen.getByRole('button', { name: 'Set up' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('says what the yes did and why a part failed, until dismissed', async () => {
    const given = props({ result: 'Meetings are processed when they arrive.', problem: 'No.' });
    render(<MeetingSetup {...given} />);
    expect(screen.getByRole('status').textContent).toBe('Meetings are processed when they arrive.');
    expect(screen.getByRole('alert').textContent).toBe('No.');
    expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(given.onDismiss).toHaveBeenCalledOnce();
  });
});
