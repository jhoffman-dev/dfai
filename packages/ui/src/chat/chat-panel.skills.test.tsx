// @vitest-environment jsdom
/**
 * The chat's skill (#169): a chip for the one attached, a picker by the box,
 * and `/name` typed at the start. The panel draws and reports; the session
 * attaches, reads and refuses.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { ChatPanel } from './chat-panel.tsx';
import type { ChatActions, ChatPanelState, ChatSkillsView } from './chat-view.ts';
import { AskPage } from './ask-page.tsx';

afterEach(cleanup);

const IDLE: ChatPanelState = { items: [], busy: false, error: null, context: null, notice: null };

function actions(): ChatActions {
  return {
    onSend: vi.fn(),
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

const CHOICES: ChatSkillsView['choices'] = [
  { name: 'weekly-review', unusable: null },
  { name: 'standup-notes', unusable: 'too-long' },
];

function skillsView(more: Partial<ChatSkillsView> = {}): ChatSkillsView {
  return {
    attached: null,
    choices: CHOICES,
    onWanted: vi.fn(),
    onAttach: vi.fn(),
    onRemove: vi.fn(),
    ...more,
  };
}

/** The panel, its draft kept as the app keeps it. */
function Panel({ skills, onSend }: { skills?: ChatSkillsView; onSend?: (text: string) => void }) {
  const [text, setText] = useState('');
  return (
    <ChatPanel
      state={IDLE}
      model="claude-opus-5-5"
      problem={null}
      history={{ chats: [], open: false, onOpenChange: vi.fn(), onPick: vi.fn(), problem: null }}
      actions={{ ...actions(), ...(onSend !== undefined && { onSend }) }}
      loadImage={async () => null}
      draft={{ text, onChange: setText }}
      {...(skills !== undefined && { skills })}
    />
  );
}

const box = () => screen.getByRole('textbox', { name: 'Ask Claude' });

describe('the chat panel’s skill', () => {
  it('reads no skills until the picker is wanted, then lists them to attach one', async () => {
    const skills = skillsView();
    render(<Panel skills={skills} />);
    expect(skills.onWanted).not.toHaveBeenCalled();
    expect(screen.queryByRole('group', { name: 'Skills' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Use a skill' }));
    expect(skills.onWanted).toHaveBeenCalled();
    const picker = screen.getByRole('group', { name: 'Skills' });
    expect(within(picker).getByRole('button', { name: /standup-notes too long/ })).toBeTruthy();
    await userEvent.click(within(picker).getByRole('button', { name: 'weekly-review' }));

    expect(skills.onAttach).toHaveBeenCalledWith('weekly-review');
    expect(screen.queryByRole('group', { name: 'Skills' })).toBeNull();
  });

  it('shows the attached skill as a chip that can be taken off', async () => {
    const skills = skillsView({ attached: { name: 'weekly-review', problem: null } });
    render(<Panel skills={skills} />);
    expect(screen.getByText('weekly-review')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    await userEvent.click(
      screen.getByRole('button', { name: 'Remove the skill weekly-review from the chat' }),
    );
    expect(skills.onRemove).toHaveBeenCalled();
  });

  it('says on the chip why the attached skill cannot be asked with', () => {
    const problem =
      'The skill weekly-review cannot be used: Its instructions are 20001 characters.';
    render(<Panel skills={skillsView({ attached: { name: 'weekly-review', problem } })} />);
    expect(screen.getByRole('alert').textContent).toBe(problem);
  });

  it('opens the picker on /, narrowed by what follows, and a pick clears what was typed', async () => {
    const skills = skillsView();
    render(<Panel skills={skills} />);
    await userEvent.type(box(), '/week');
    expect(skills.onWanted).toHaveBeenCalled();
    const picker = screen.getByRole('group', { name: 'Skills' });
    expect(
      within(picker)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['weekly-review']);
    await userEvent.click(within(picker).getByRole('button', { name: 'weekly-review' }));
    expect(skills.onAttach).toHaveBeenCalledWith('weekly-review');
    expect((box() as HTMLTextAreaElement).value).toBe('');
  });

  it('says when no skill starts with what was typed, and closes on Escape', async () => {
    render(<Panel skills={skillsView()} />);
    await userEvent.type(box(), '/zzz');
    expect(screen.getByText('No skill starts with /zzz.')).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('group', { name: 'Skills' })).toBeNull();
    expect((box() as HTMLTextAreaElement).value).toBe('/zzz');
  });

  it('closes the / picker once a question follows the name, and sends /name as typed', async () => {
    const onSend = vi.fn();
    render(<Panel skills={skillsView()} onSend={onSend} />);
    await userEvent.type(box(), '/weekly-review what did I finish?');
    expect(screen.queryByRole('group', { name: 'Skills' })).toBeNull();
    await userEvent.keyboard('{Enter}');
    expect(onSend).toHaveBeenCalledWith('/weekly-review what did I finish?');
  });

  it('offers no skill and no picker when the app gives none', async () => {
    render(<Panel />);
    expect(screen.queryByRole('button', { name: 'Use a skill' })).toBeNull();
    await userEvent.type(box(), '/week');
    expect(screen.queryByRole('group', { name: 'Skills' })).toBeNull();
  });
});

describe('Ask’s skill', () => {
  it('shows the chip and the picker, since Ask is the same chat', async () => {
    const skills = skillsView({ attached: { name: 'weekly-review', problem: null } });
    render(
      <AskPage
        state={{ entries: [], busy: false, error: null, notice: null }}
        model="claude-opus-5-5"
        problem={null}
        recent={[]}
        recentProblem={null}
        draft={{ text: '', onChange: vi.fn() }}
        focusRequest={null}
        onFocusTaken={vi.fn()}
        actions={{ ...actions(), onPickRecent: vi.fn() }}
        loadImage={async () => null}
        skills={skills}
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Remove the skill weekly-review from the chat' }),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Use a skill' }));
    expect(screen.getByRole('group', { name: 'Skills' })).toBeTruthy();
  });
});
