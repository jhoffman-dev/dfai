// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { citeAnswer, uncitedCount, type EditorDocument } from '@dfai/domain';
import { PageBar } from '../page-bar.tsx';
import { ChatPanel } from './chat-panel.tsx';
import { ChatToggleProvider } from './chat-toggle.tsx';
import type { AskAnswerView, ChatActions, ChatItemView, ChatPanelState } from './chat-view.ts';

const paragraph = (text: string): EditorDocument => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

function actions(): ChatActions & Record<string, ReturnType<typeof vi.fn>> {
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

const answer = (text: string, checked = true): AskAnswerView => {
  const blocks = citeAnswer(text);
  return { kind: 'answer', id: 'a', text, blocks, uncited: uncitedCount(blocks), checked };
};

const IDLE: ChatPanelState = { items: [], busy: false, error: null, context: null, notice: null };

function panel(
  state: Partial<ChatPanelState> = {},
  extra: Partial<Parameters<typeof ChatPanel>[0]> = {},
) {
  const handlers = actions();
  const history = {
    chats: [],
    open: false,
    onOpenChange: vi.fn(),
    onPick: vi.fn(),
    problem: null,
  };
  render(
    <ChatPanel
      state={{ ...IDLE, ...state }}
      model="claude-opus-5-5"
      problem={null}
      history={history}
      actions={handlers}
      loadImage={async () => null}
      {...extra}
    />,
  );
  return { handlers, history };
}

const proposal = (
  state: 'pending' | 'accepted' | 'rejected' | 'undone',
  problem: string | null = null,
): ChatItemView => ({
  kind: 'proposal',
  id: 'p1',
  state,
  problem,
  proposal: {
    kind: 'edit',
    title: 'Plan',
    path: 'Plan.md',
    blocks: [
      { kind: 'folded', count: 2 },
      { kind: 'removed', doc: paragraph('Call Sam') },
      { kind: 'added', doc: paragraph('Called Sam') },
    ],
    propertyChanges: [{ key: 'status', before: 'open', after: 'done' }],
  },
});

describe('ChatPanel, with no name in the profile', () => {
  it('offers to set the name before the first question, and says what Claude writes meanwhile', async () => {
    const onSetName = vi.fn();
    panel({}, { nameHint: { placeholder: '[Your name]', onSetName } });
    const log = screen.getByRole('log', { name: 'Conversation' });
    expect(within(log).queryByText(/it writes “\[Your name\]” rather than guess/)).not.toBeNull();
    await userEvent.click(within(log).getByRole('button', { name: 'Set your name' }));
    expect(onSetName).toHaveBeenCalledOnce();
  });

  it('says nothing about the name once one is set, or once the chat has begun', () => {
    panel();
    expect(screen.getByRole('log', { name: 'Conversation' }).textContent).toContain('Ask about');
    expect(screen.queryByRole('button', { name: 'Set your name' })).toBeNull();
    cleanup();
    panel(
      { items: [{ kind: 'user', id: 'u1', text: 'Hi' }] },
      { nameHint: { placeholder: '[Your name]', onSetName: vi.fn() } },
    );
    expect(screen.queryByRole('button', { name: 'Set your name' })).toBeNull();
  });
});

describe('ChatPanel', () => {
  it('takes the keys on mount only when the mount was asked for', () => {
    panel({}, { focusOnMount: false });
    const box = screen.getByRole('textbox', { name: 'Ask Claude' });
    expect(document.activeElement).not.toBe(box);
  });

  it('opens with the window as a removable chip, and sends what is typed on Enter', async () => {
    const user = userEvent.setup();
    const { handlers } = panel({ context: { kind: 'note', title: 'Q3 plan' } });

    const box = screen.getByRole('textbox', { name: 'Ask Claude' });
    expect(document.activeElement).toBe(box);
    expect(screen.getByText('Q3 plan')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Remove Q3 plan from the chat' }));
    expect(handlers['onRemoveContext']).toHaveBeenCalled();

    await user.type(box, 'Line one{Shift>}{Enter}{/Shift}line two{Enter}');
    expect(handlers['onSend']).toHaveBeenCalledWith('Line one\nline two');
    expect((box as HTMLTextAreaElement).value).toBe('');
  });

  it('will not send an empty question', async () => {
    const user = userEvent.setup();
    const { handlers } = panel();
    expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(true);
    await user.type(screen.getByRole('textbox', { name: 'Ask Claude' }), '   {Enter}');
    expect(handlers['onSend']).not.toHaveBeenCalled();
  });

  it('shows Stop while Claude is working', async () => {
    const user = userEvent.setup();
    const { handlers } = panel({ busy: true, items: [{ kind: 'user', id: 'u', text: 'Hi' }] });
    expect(screen.getByRole('status').textContent).toBe('Claude is working…');
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(handlers['onStop']).toHaveBeenCalled();
  });

  it('shows the conversation with each tool call in it, and copies or retries an answer', async () => {
    const user = userEvent.setup();
    const { handlers } = panel({
      items: [
        { kind: 'user', id: 'u', text: 'Who is Sam?' },
        { kind: 'tool', id: 't1', label: 'Searched for “Sam”', state: 'done', detail: null },
        {
          kind: 'tool',
          id: 't2',
          label: 'Read Gone.md',
          state: 'failed',
          detail: 'not_found: No note',
        },
        answer('Sam is a friend [[Sam]].'),
      ],
    });
    const log = screen.getByRole('log', { name: 'Conversation' });
    expect(within(log).getByText('Searched for “Sam”')).toBeTruthy();
    expect(within(log).getByText('not_found: No note')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Copy answer' }));
    expect(handlers['onCopy']).toHaveBeenCalledWith('Sam is a friend [[Sam]].');
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(handlers['onRetry']).toHaveBeenCalled();
  });

  it('shows a failure with Retry', async () => {
    const user = userEvent.setup();
    const { handlers } = panel({
      error: { message: 'Claude Code is installed but not logged in.' },
    });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('not logged in');
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(handlers['onRetry']).toHaveBeenCalled();
  });

  it('says how to fix a provider that cannot be reached, with the command to copy', async () => {
    const user = userEvent.setup();
    const { handlers } = panel(
      {},
      { problem: { message: 'Claude Code is not logged in.', fix: 'claude auth login' } },
    );
    expect(screen.getByRole('alert').textContent).toContain('claude auth login');
    await user.click(screen.getByRole('button', { name: 'Copy the fix' }));
    expect(handlers['onCopy']).toHaveBeenCalledWith('claude auth login');
  });

  it('lists past chats and opens one', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    const onOpenChange = vi.fn();
    panel(
      {},
      {
        history: {
          chats: [{ path: 'Chats/Sam.md', title: 'Sam' }],
          open: true,
          onOpenChange,
          onPick,
          problem: null,
        },
      },
    );
    await user.click(
      within(screen.getByRole('navigation', { name: 'Past chats' })).getByRole('button', {
        name: 'Sam',
      }),
    );
    expect(onPick).toHaveBeenCalledWith('Chats/Sam.md');
    await user.click(screen.getByRole('button', { name: 'Past chats' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('ChatPanel, an answer read for its citations (#548)', () => {
  const ANSWER = 'Mara wants the rollback plan [[Larkspur Kickoff#^t0003]].\n\nIt may slip a week.';

  it('draws a citation as a chip that follows its link, ⌘-click in a new tab', async () => {
    const { handlers } = panel({ items: [answer(ANSWER)] });
    const reply = screen.getByRole('region', { name: 'Answer' });
    const chip = within(reply).getByRole('button', { name: 'Larkspur Kickoff' });
    expect(reply.textContent).not.toContain('[[');
    await userEvent.click(chip);
    expect(handlers['onFollowCitation']).toHaveBeenCalledWith(
      '[[Larkspur Kickoff#^t0003]]',
      'here',
    );
    fireEvent.click(chip, { metaKey: true });
    expect(handlers['onFollowCitation']).toHaveBeenLastCalledWith(
      '[[Larkspur Kickoff#^t0003]]',
      'new-tab',
    );
  });

  it('marks the paragraph that cites nothing, keeps its words, and counts it in the foot', () => {
    panel({ items: [answer(ANSWER)] });
    const reply = screen.getByRole('region', { name: 'Answer' });
    const marked = reply.querySelectorAll('[data-uncited]');
    expect(marked).toHaveLength(1);
    expect(marked[0]?.textContent).toContain('It may slip a week.');
    expect(within(marked[0] as HTMLElement).getByText('not cited')).toBeTruthy();
    expect(within(reply).getByText('1 paragraph not cited')).toBeTruthy();
  });

  it('marks nothing on an answer still arriving', () => {
    panel({ items: [answer(ANSWER, false)], busy: true });
    const reply = screen.getByRole('region', { name: 'Answer' });
    expect(within(reply).getByText(/It may slip a week\./)).toBeTruthy();
    expect(reply.querySelectorAll('[data-uncited]')).toHaveLength(0);
    expect(within(reply).queryByText(/not cited/)).toBeNull();
  });

  it('opens an https link in the browser, and leaves any other link as text', async () => {
    const { handlers } = panel({
      items: [
        answer(
          'See [the guide](https://example.com/guide) [[Guide]] and [this](javascript:alert(1)) [[Guide]].',
        ),
      ],
    });
    const reply = screen.getByRole('region', { name: 'Answer' });
    await userEvent.click(within(reply).getByRole('link', { name: /the guide/ }));
    expect(handlers['onOpenWeb']).toHaveBeenCalledWith('https://example.com/guide');
    expect(within(reply).getAllByRole('link')).toHaveLength(1);
    expect(reply.textContent).toContain('[this](javascript:alert(1))');
  });
});

describe('ChatPanel, Past chats', () => {
  it('says why a picked chat could not be opened, and still lists the rest', () => {
    panel(
      {},
      {
        history: {
          chats: [{ path: 'Chats/Payroll cutover.md', title: 'Payroll cutover' }],
          open: true,
          onOpenChange: vi.fn(),
          onPick: vi.fn(),
          problem: 'That chat could not be opened: not_found: Chats/Gone.md',
        },
      },
    );
    const list = screen.getByRole('navigation', { name: 'Past chats' });
    expect(within(list).getByRole('alert').textContent).toBe(
      'That chat could not be opened: not_found: Chats/Gone.md',
    );
    expect(within(list).getByRole('button', { name: 'Payroll cutover' })).toBeTruthy();
  });
});

describe('ChatPanel, Past chats while an answer arrives (#548)', () => {
  it('cannot be picked from, and says why, until the answer is finished', async () => {
    const onPick = vi.fn();
    const history = {
      chats: [{ path: 'Chats/Payroll cutover.md', title: 'Payroll cutover' }],
      open: true,
      onOpenChange: vi.fn(),
      onPick,
      problem: null,
    };
    panel({ busy: true }, { history });
    const row = within(screen.getByRole('navigation', { name: 'Past chats' })).getByRole('button', {
      name: 'Payroll cutover',
    });
    expect(row).toHaveProperty('disabled', true);
    expect(row.getAttribute('title')).toBe('Wait for the answer to finish');
    await userEvent.click(row);
    expect(onPick).not.toHaveBeenCalled();

    cleanup();
    panel({ busy: false }, { history });
    const idle = screen.getByRole('button', { name: 'Payroll cutover' });
    expect(idle).toHaveProperty('disabled', false);
    expect(idle.getAttribute('title')).toBeNull();
  });

  it('says a list that could not be read, never that there are no chats', () => {
    panel(
      {},
      {
        history: {
          chats: [],
          open: true,
          onOpenChange: vi.fn(),
          onPick: vi.fn(),
          problem: 'Past chats could not be read: Operation not permitted (os error 1)',
        },
      },
    );
    const list = screen.getByRole('navigation', { name: 'Past chats' });
    expect(within(list).getByRole('alert').textContent).toContain('could not be read');
    expect(list.textContent).not.toContain('No chats yet');
  });
});

describe('a proposed change', () => {
  it('is drawn as blocks, removed and added, with its property changes, and waits for Accept', async () => {
    const user = userEvent.setup();
    const { handlers } = panel({ items: [proposal('pending')] });
    const card = screen.getByRole('region', { name: 'Proposed edit: Plan' });
    expect(within(card).getByText('2 unchanged blocks')).toBeTruthy();
    expect(card.querySelector('.chat-proposal__block--removed')?.textContent).toContain('Call Sam');
    expect(card.querySelector('.chat-proposal__block--added')?.textContent).toContain('Called Sam');
    expect(within(card).getByRole('list', { name: 'Property changes' }).textContent).toContain(
      'statusopendone',
    );

    await user.click(within(card).getByRole('button', { name: 'Reject' }));
    expect(handlers['onReject']).toHaveBeenCalledWith('p1');
    await user.click(within(card).getByRole('button', { name: 'Accept' }));
    expect(handlers['onAccept']).toHaveBeenCalledWith('p1');
  });

  it('tells Accept from Reject: a positive and a destructive button (#318)', () => {
    panel({ items: [proposal('pending')] });
    const card = screen.getByRole('region', { name: 'Proposed edit: Plan' });
    expect(within(card).getByRole('button', { name: 'Accept' }).classList).toContain(
      'btn--positive',
    );
    expect(within(card).getByRole('button', { name: 'Reject' }).classList).toContain(
      'btn--destructive',
    );
  });

  it('offers Undo once accepted, and says why an Accept was refused', async () => {
    const user = userEvent.setup();
    const { handlers } = panel({
      items: [proposal('accepted', 'Plan changed since this was proposed')],
    });
    const card = screen.getByRole('region', { name: 'Proposed edit: Plan' });
    expect(within(card).queryByRole('button', { name: 'Accept' })).toBeNull();
    expect(within(card).getByRole('alert').textContent).toContain('changed since');
    await user.click(within(card).getByRole('button', { name: 'Undo' }));
    expect(handlers['onUndo']).toHaveBeenCalledWith('p1');
  });

  it('says it was rejected, with nothing left to press', () => {
    panel({ items: [proposal('rejected')] });
    const card = screen.getByRole('region', { name: 'Proposed edit: Plan' });
    expect(within(card).getByRole('status').textContent).toBe('Rejected');
    expect(within(card).queryAllByRole('button')).toHaveLength(0);
  });
});

describe('the chat button in a page bar', () => {
  it('is there only when the app offers a chat, and toggles it', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<PageBar crumb={null} name={null} />);
    expect(screen.queryByRole('button', { name: 'Claude' })).toBeNull();
    unmount();

    const onToggle = vi.fn();
    render(
      <ChatToggleProvider value={{ open: true, onToggle }}>
        <PageBar crumb={null} name={null} />
      </ChatToggleProvider>,
    );
    const button = screen.getByRole('button', { name: 'Claude' });
    expect(button.getAttribute('aria-pressed')).toBe('true');
    await user.click(button);
    expect(onToggle).toHaveBeenCalled();
  });
});
