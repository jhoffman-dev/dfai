// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { EditorDocument } from '@dfai/domain';
import { ChatPanel } from './chat-panel.tsx';
import type { ChatActions, ChatItemView } from './chat-view.ts';

/**
 * Adversarial (P27-04): Accept writes to `proposal.path`, so the card must say
 * which note that is. Two notes can share a title in different folders; the
 * card shows only the title.
 */

const paragraph = (text: string): EditorDocument => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const actions: ChatActions = {
  onSend: vi.fn(),
  onStop: vi.fn(),
  onRetry: vi.fn(),
  onNewChat: vi.fn(),
  onClose: vi.fn(),
  onRemoveContext: vi.fn(),
  onFollowCitation: vi.fn(),
  onOpenWeb: vi.fn(),
  onAccept: vi.fn(),
  onReject: vi.fn(),
  onUndo: vi.fn(),
  onCopy: vi.fn(),
  onFollowLink: vi.fn(),
};

const edit = (path: string): ChatItemView => ({
  kind: 'proposal',
  id: path,
  state: 'pending',
  problem: null,
  proposal: {
    kind: 'edit',
    title: 'Plan',
    path,
    blocks: [{ kind: 'added', doc: paragraph('Close the account.') }],
    propertyChanges: [],
  },
});

describe('a proposal card (adversarial)', () => {
  it('names the folder of the note Accept will write, not only its title', () => {
    render(
      <ChatPanel
        state={{
          items: [edit('Clients/Acme/Plan.md'), edit('Personal/Plan.md')],
          busy: false,
          error: null,
          context: null,
          notice: null,
        }}
        model="claude-opus-5-5"
        problem={null}
        history={{ chats: [], open: false, onOpenChange: vi.fn(), onPick: vi.fn(), problem: null }}
        actions={actions}
        loadImage={async () => null}
      />,
    );
    const cards = screen.getAllByRole('region', { name: 'Proposed edit: Plan' });
    expect(cards).toHaveLength(2);
    expect(within(cards[0]!).queryByText(/Clients\/Acme/)).not.toBeNull();
    expect(within(cards[1]!).queryByText(/Personal/)).not.toBeNull();
  });

  it('names the vault path a proposed new note will be written to', () => {
    const note: ChatItemView = {
      kind: 'proposal',
      id: 'n1',
      state: 'pending',
      problem: null,
      proposal: {
        kind: 'note',
        title: 'Idea',
        path: 'Projects/Idea 2.md',
        blocks: [{ kind: 'added', doc: paragraph('x') }],
        propertyChanges: [],
      },
    };
    renderPanel([note]);
    const card = screen.getByRole('region', { name: 'Proposed new note: Idea' });
    expect(within(card).queryByText('Projects/Idea 2.md')).not.toBeNull();
  });

  it('offers neither Accept nor Reject while an Accept is being written', () => {
    const accepting: ChatItemView = { ...edit('Plan.md'), state: 'accepting' } as ChatItemView;
    renderPanel([accepting]);
    const card = screen.getByRole('region', { name: 'Proposed edit: Plan' });
    const button = (name: string) => within(card).getByRole<HTMLButtonElement>('button', { name });
    expect(button('Accept').disabled).toBe(true);
    expect(button('Reject').disabled).toBe(true);
  });
});

function renderPanel(items: ChatItemView[]) {
  render(
    <ChatPanel
      state={{ items, busy: false, error: null, context: null, notice: null }}
      model="claude-opus-5-5"
      problem={null}
      history={{ chats: [], open: false, onOpenChange: vi.fn(), onPick: vi.fn(), problem: null }}
      actions={actions}
      loadImage={async () => null}
    />,
  );
}
