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
function Panel({
  skills,
  onSend,
  error = null,
}: {
  skills?: ChatSkillsView;
  onSend?: (text: string) => void;
  error?: string | null;
}) {
  const [text, setText] = useState('');
  return (
    <ChatPanel
      state={{ ...IDLE, error: error === null ? null : { message: error } }}
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
    const picker = screen.getByRole('listbox', { name: 'Skills' });
    expect(within(picker).getByRole('option', { name: /standup-notes too long/ })).toBeTruthy();
    await userEvent.click(within(picker).getByRole('option', { name: 'weekly-review' }));

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
    expect(screen.getByText(problem, { selector: '.chat__skill-problem' })).toBeTruthy();
    // Said once, politely, by the composer: not an alert of its own beside the turn's.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe(problem);
  });

  it('opens the picker on /, narrowed by what follows, and a pick clears what was typed', async () => {
    const skills = skillsView();
    render(<Panel skills={skills} />);
    await userEvent.type(box(), '/week');
    expect(skills.onWanted).toHaveBeenCalled();
    const picker = screen.getByRole('listbox', { name: 'Skills' });
    expect(
      within(picker)
        .getAllByRole('option')
        .map((button) => button.textContent),
    ).toEqual(['weekly-review']);
    await userEvent.click(within(picker).getByRole('option', { name: 'weekly-review' }));
    expect(skills.onAttach).toHaveBeenCalledWith('weekly-review');
    expect((box() as HTMLTextAreaElement).value).toBe('');
  });

  it('says when no skill starts with what was typed, and closes on Escape', async () => {
    render(<Panel skills={skillsView()} />);
    await userEvent.type(box(), '/zzz');
    expect(
      within(screen.getByRole('listbox', { name: 'Skills' })).getByText(
        'No skill starts with /zzz.',
      ),
    ).toBeTruthy();
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

describe('the skill picker by keyboard, and what it says (PR #635 review)', () => {
  const MANY: ChatSkillsView['choices'] = [
    { name: 'weekly-review', unusable: null },
    { name: 'weekly-plan', unusable: null },
    { name: 'standup-notes', unusable: null },
  ];

  it('is a listbox the box controls, and says how many skills match', async () => {
    render(<Panel skills={skillsView({ choices: MANY })} />);
    await userEvent.type(box(), '/week');
    const picker = screen.getByRole('listbox', { name: 'Skills' });
    expect(box().getAttribute('aria-controls')).toBe(picker.id);
    expect(screen.getByRole('status').textContent).toBe('2 skills match');
    await userEvent.type(box(), 'ly-r');
    expect(screen.getByRole('status').textContent).toBe('1 skill matches');
    await userEvent.type(box(), 'x');
    expect(screen.getByRole('status').textContent).toBe('No skill starts with /weekly-rx.');
  });

  it('moves through the matches with the arrow keys and picks with Enter, sending nothing', async () => {
    const skills = skillsView({ choices: MANY });
    const onSend = vi.fn();
    render(<Panel skills={skills} onSend={onSend} />);
    await userEvent.type(box(), '/week');
    const options = within(screen.getByRole('listbox', { name: 'Skills' })).getAllByRole('option');
    expect(box().getAttribute('aria-activedescendant')).toBe(options[0]?.id);
    expect(options[0]?.getAttribute('aria-selected')).toBe('true');

    await userEvent.keyboard('{ArrowDown}');
    expect(box().getAttribute('aria-activedescendant')).toBe(options[1]?.id);
    await userEvent.keyboard('{ArrowDown}');
    expect(box().getAttribute('aria-activedescendant')).toBe(options[1]?.id);
    await userEvent.keyboard('{ArrowUp}{ArrowDown}{Enter}');

    expect(skills.onAttach).toHaveBeenCalledWith('weekly-plan');
    expect(onSend).not.toHaveBeenCalled();
    expect((box() as HTMLTextAreaElement).value).toBe('');
    expect(box().getAttribute('aria-activedescendant')).toBeNull();
  });

  it('picks the first match with Enter when the arrows were not used', async () => {
    const skills = skillsView({ choices: MANY });
    render(<Panel skills={skills} />);
    await userEvent.type(box(), '/stand{Enter}');
    expect(skills.onAttach).toHaveBeenCalledWith('standup-notes');
  });

  it('sends with Enter when nothing matches', async () => {
    const onSend = vi.fn();
    render(<Panel skills={skillsView({ choices: MANY })} onSend={onSend} />);
    await userEvent.type(box(), '/zzz{Enter}');
    expect(onSend).toHaveBeenCalledWith('/zzz');
  });

  it('works the picker opened by its button from the box too', async () => {
    const skills = skillsView({ choices: MANY });
    render(<Panel skills={skills} />);
    await userEvent.click(screen.getByRole('button', { name: 'Use a skill' }));
    expect(document.activeElement).toBe(box());
    expect(screen.getByRole('status').textContent).toBe('3 skills match');
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(skills.onAttach).toHaveBeenCalledWith('standup-notes');
  });

  it('leaves the chip’s problem to the turn’s alert once the turn says it', () => {
    const problem = 'The skill weekly-review is not in .atlas/skills.';
    render(
      <Panel
        skills={skillsView({ attached: { name: 'weekly-review', problem } })}
        error={problem}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain(problem);
    expect(screen.getByRole('status').textContent).toBe('');
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
    expect(screen.getByRole('listbox', { name: 'Skills' })).toBeTruthy();
  });
});
