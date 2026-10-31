// @vitest-environment jsdom
/**
 * PR #635 attack: the skill picker by keyboard, and what the composer's live
 * region and the turn's alert say between them as a refused turn is asked
 * again.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { ChatPanel } from './chat-panel.tsx';
import type { ChatActions, ChatPanelState, ChatSkillsView } from './chat-view.ts';

afterEach(cleanup);

const IDLE: ChatPanelState = { items: [], busy: false, error: null, context: null, notice: null };
const PROBLEM = 'The skill weekly-review is not in .atlas/skills.';

function actions(onSend: (text: string) => void = vi.fn()): ChatActions {
  return {
    onSend,
    onStop: vi.fn(),
    onRetry: vi.fn(),
    onNewChat: vi.fn(),
    onClose: vi.fn(),
    onRemoveContext: vi.fn(),
    onAccept: vi.fn(),
    onReject: vi.fn(),
    onUndo: vi.fn(),
    onCopy: vi.fn(),
    onFollowLink: vi.fn(),
    onFollowCitation: vi.fn(),
    onOpenWeb: vi.fn(),
  };
}

function skillsView(more: Partial<ChatSkillsView> = {}): ChatSkillsView {
  return {
    attached: null,
    choices: [
      { name: 'weekly-review', unusable: null },
      { name: 'weekly-plan', unusable: null },
      { name: 'standup-notes', unusable: null },
    ],
    onWanted: vi.fn(),
    onAttach: vi.fn(),
    onRemove: vi.fn(),
    ...more,
  };
}

function Panel({
  state = IDLE,
  skills,
  onSend,
}: {
  state?: ChatPanelState;
  skills: ChatSkillsView;
  onSend?: (text: string) => void;
}) {
  const [text, setText] = useState('');
  return (
    <ChatPanel
      state={state}
      model="claude-opus-5-5"
      problem={null}
      history={{ chats: [], open: false, onOpenChange: vi.fn(), onPick: vi.fn(), problem: null }}
      actions={actions(onSend)}
      loadImage={async () => null}
      draft={{ text, onChange: setText }}
      skills={skills}
    />
  );
}

const box = () => screen.getByRole('textbox', { name: 'Ask Claude' });
const status = () => screen.getByRole('status').textContent ?? '';
const alerts = () => screen.queryAllByRole('alert').map((each) => each.textContent ?? '');

describe('what is said of a refused skill as its turn is asked again (PR #635 attack)', () => {
  it('says the problem once per Enter, not by the live region and then the alert', () => {
    const skills = skillsView({ attached: { name: 'weekly-review', problem: PROBLEM } });
    const refused: ChatPanelState = { ...IDLE, error: { message: PROBLEM } };
    // As the session goes: refused, asked again (busy, error cleared), refused again.
    const states: ChatPanelState[] = [refused, { ...IDLE, busy: true }, refused];
    const { rerender } = render(<Panel state={states[0] ?? IDLE} skills={skills} />);
    let said = 0;
    let lastStatus = status();
    let lastAlert = alerts().join('');
    for (const state of states.slice(1)) {
      rerender(<Panel state={state} skills={skills} />);
      // A live region speaks when its text changes to something; an alert when it appears.
      if (status() !== lastStatus && status().includes(PROBLEM)) said += 1;
      if (alerts().join('') !== lastAlert && alerts().some((text) => text.includes(PROBLEM))) {
        said += 1;
      }
      lastStatus = status();
      lastAlert = alerts().join('');
    }
    expect(said).toBe(1);
  });
});

describe('the skill picker by keyboard (PR #635 attack)', () => {
  it('points aria-activedescendant at an option that exists, as the arrows move and the matches narrow', async () => {
    render(<Panel skills={skillsView()} />);
    await userEvent.type(box(), '/');
    for (const key of ['{ArrowDown}', '{ArrowDown}', '{ArrowDown}', '{ArrowDown}', '{ArrowUp}']) {
      await userEvent.keyboard(key);
      const active = box().getAttribute('aria-activedescendant');
      expect(active).not.toBeNull();
      const option = document.getElementById(active ?? '');
      expect(option?.getAttribute('role')).toBe('option');
      expect(option?.getAttribute('aria-selected')).toBe('true');
    }
    await userEvent.type(box(), 'week');
    const narrowed = document.getElementById(box().getAttribute('aria-activedescendant') ?? '');
    expect(narrowed?.textContent).toMatch(/^weekly-/);
    await userEvent.type(box(), 'zz');
    expect(box().getAttribute('aria-activedescendant')).toBeNull();
  });

  it('never sends the /word while a match shows, and sends it once nothing matches', async () => {
    const onSend = vi.fn();
    const skills = skillsView();
    render(<Panel skills={skills} onSend={onSend} />);
    await userEvent.type(box(), '/stand');
    await userEvent.keyboard('{Enter}');
    expect(onSend).not.toHaveBeenCalled();
    expect(skills.onAttach).toHaveBeenCalledWith('standup-notes');
    await userEvent.type(box(), '/nope');
    await userEvent.keyboard('{Enter}');
    expect(onSend).toHaveBeenCalledWith('/nope');
  });

  it('says the count once, in one live region, and the empty case in words', async () => {
    render(<Panel skills={skillsView()} />);
    await userEvent.type(box(), '/week');
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(status()).toBe('2 skills match');
    await userEvent.type(box(), 'ly-r');
    expect(status()).toBe('1 skill matches');
    await userEvent.type(box(), 'x');
    expect(status()).toBe('No skill starts with /weekly-rx.');
  });
});
