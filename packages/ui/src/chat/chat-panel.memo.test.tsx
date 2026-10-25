// @vitest-environment jsdom
import { memo, type FunctionComponent } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { citeAnswer, uncitedCount } from '@dfai/domain';
import type * as AskAnswerModule from './ask-answer.tsx';
import type { AnswerLinks } from './ask-answer.tsx';
import type { AskAnswerView, ChatActions, ChatPanelState } from './chat-view.ts';

interface AskAnswerProps {
  readonly answer: AskAnswerView;
  readonly links: AnswerLinks;
}

/** Which answers AskAnswer drew, by id, in order: the component as shipped, its memo kept. */
const drawn = vi.hoisted(() => [] as string[]);

vi.mock('./ask-answer.tsx', async (importOriginal) => {
  const shipped = await importOriginal<typeof AskAnswerModule>();
  // `memo` keeps the component it wraps as `type`; wrapped again the same way, only the spy is new.
  const inner = (shipped.AskAnswer as unknown as { type: FunctionComponent<AskAnswerProps> }).type;
  function SpiedAskAnswer({ answer, links }: AskAnswerProps) {
    drawn.push(answer.id);
    return inner({ answer, links });
  }
  return { ...shipped, AskAnswer: memo(SpiedAskAnswer) };
});

const { ChatPanel } = await import('./chat-panel.tsx');

const answer = (id: string, text: string, checked: boolean): AskAnswerView => {
  const blocks = citeAnswer(text);
  return { kind: 'answer', id, text, blocks, uncited: uncitedCount(blocks), checked };
};

const actions: ChatActions = {
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
const history = { chats: [], open: false, onOpenChange: vi.fn(), onPick: vi.fn(), problem: null };

describe('ChatPanel while an answer streams (#548)', () => {
  it('draws the finished answer once, and only the arriving one with each word', () => {
    const finished = answer('a1', 'Mara Quill owns it [[Rollback#^r1]].', true);
    const state = (text: string): ChatPanelState => ({
      items: [
        { kind: 'user', id: 'u1', text: 'Who owns the rollback?' },
        finished,
        { kind: 'user', id: 'u2', text: 'And the cutover?' },
        answer('a2', text, false),
      ],
      busy: true,
      error: null,
      context: null,
      notice: null,
    });
    const panel = (text: string) => (
      <ChatPanel
        state={state(text)}
        model="claude-opus-5-5"
        problem={null}
        history={history}
        actions={actions}
        loadImage={async () => null}
      />
    );
    const { rerender } = render(panel('Tobias'));
    for (const text of ['Tobias Fenn', 'Tobias Fenn owns', 'Tobias Fenn owns it.']) {
      rerender(panel(text));
    }
    expect(drawn.filter((id) => id === 'a1')).toHaveLength(1);
    expect(drawn.filter((id) => id === 'a2')).toHaveLength(4);
  });
});
