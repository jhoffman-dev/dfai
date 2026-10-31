// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SkillAsk, type SkillAskView, type SkillDraftPreview } from './skill-ask.tsx';

afterEach(cleanup);

const PREVIEW: SkillDraftPreview = {
  name: null,
  description: [{ kind: 'same', text: 'Summarises meeting notes.' }],
  instructions: [
    { kind: 'folded', count: 3 },
    { kind: 'removed', text: 'List everything Tobias Fenn said.' },
    { kind: 'added', text: 'List the decisions.' },
  ],
  note: null,
};

function viewOf(overrides: Partial<SkillAskView> = {}): SkillAskView {
  return {
    open: true,
    request: 'Make this shorter.',
    asking: false,
    preview: null,
    problem: null,
    onOpen: vi.fn(),
    onClose: vi.fn(),
    onRequestChange: vi.fn(),
    onAsk: vi.fn(),
    onStop: vi.fn(),
    onAccept: vi.fn(),
    onDiscard: vi.fn(),
    ...overrides,
  };
}

const show = (ask: SkillAskView, saving = false) => render(<SkillAsk ask={ask} saving={saving} />);

describe('SkillAsk', () => {
  it('starts as a button that opens the request field', async () => {
    const ask = viewOf({ open: false });
    show(ask);
    expect(screen.queryByRole('region', { name: 'Ask Claude' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Ask Claude…' }));
    expect(ask.onOpen).toHaveBeenCalledOnce();
  });

  it('asks with the request, by Ask or ⌘↩, and not while the request is blank', async () => {
    const ask = viewOf();
    const { rerender } = show(ask);
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await userEvent.type(
      screen.getByRole('textbox', { name: 'What should Claude do?' }),
      '{Meta>}{Enter}{/Meta}',
    );
    expect(ask.onAsk).toHaveBeenCalledTimes(2);

    const blank = viewOf({ request: '  ' });
    rerender(<SkillAsk ask={blank} saving={false} />);
    expect((screen.getByRole('button', { name: 'Ask' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('while asking, offers Stop and holds the request', async () => {
    const ask = viewOf({ asking: true });
    show(ask);
    expect(screen.getByRole('status').textContent).toContain('Asking Claude…');
    expect(
      screen.getByRole('textbox', { name: 'What should Claude do?' }).hasAttribute('readonly'),
    ).toBe(true);
    expect(screen.queryByRole('button', { name: 'Ask' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(ask.onStop).toHaveBeenCalledOnce();
  });

  it('previews the draft as a diff of the description and the instructions', () => {
    show(viewOf({ preview: PREVIEW }));
    const draft = screen.getByRole('region', { name: 'Claude’s draft' });
    expect(within(draft).getByRole('group', { name: 'Description' }).textContent).toContain(
      'Unchanged.',
    );
    const instructions = within(draft).getByRole('group', { name: 'Instructions' });
    const lines = within(instructions).getAllByRole('listitem');
    expect(lines.map((line) => line.textContent)).toEqual([
      '3 unchanged lines',
      'Removed: List everything Tobias Fenn said.',
      'Added: List the decisions.',
    ]);
    expect(lines[1]?.classList.contains('skills__diff-line--removed')).toBe(true);
    expect(lines[2]?.classList.contains('skills__diff-line--added')).toBe(true);
    expect(within(draft).getByText(/Nothing is saved until you press Save/).isConnected).toBe(true);
  });

  it('says a new skill’s name, and a note beside the draft', () => {
    show(viewOf({ preview: { ...PREVIEW, name: 'standup-notes', note: 'Claude named it “x”.' } }));
    const draft = screen.getByRole('region', { name: 'Claude’s draft' });
    expect(within(draft).getByText('standup-notes').isConnected).toBe(true);
    expect(within(draft).getByText('Claude named it “x”.').isConnected).toBe(true);
  });

  it('offers Accept, Discard and Ask again on a draft', async () => {
    const ask = viewOf({ preview: PREVIEW });
    show(ask);
    // The preview's own Ask again stands in for Ask.
    expect(screen.queryByRole('button', { name: 'Ask' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }));
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await userEvent.click(screen.getByRole('button', { name: 'Ask again' }));
    expect(ask.onAccept).toHaveBeenCalledOnce();
    expect(ask.onDiscard).toHaveBeenCalledOnce();
    expect(ask.onAsk).toHaveBeenCalledOnce();
  });

  it('holds Accept while the skill is saving', () => {
    show(viewOf({ preview: PREVIEW }), true);
    expect((screen.getByRole('button', { name: 'Accept' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole('button', { name: 'Discard' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('says a problem, with its fix to copy, and that nothing changed', () => {
    show(viewOf({ problem: { lines: ['Claude Code is not logged in.'], fix: 'claude login' } }));
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Claude Code is not logged in.');
    expect(within(alert).getByText('claude login').tagName).toBe('CODE');
    expect(alert.textContent).toContain('Nothing in the editor was changed.');
    expect(screen.queryByRole('region', { name: 'Claude’s draft' })).toBeNull();
  });
});
