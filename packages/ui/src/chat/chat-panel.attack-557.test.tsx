// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { citeAnswer, uncitedCount } from '@dfai/domain';
import { ChatPanel } from './chat-panel.tsx';
import type { AskAnswerView, ChatActions, ChatPanelState } from './chat-view.ts';

/**
 * Attack on PR #557 (#548): the sidebar now draws the model's answers with
 * AskAnswer. The model's words are untrusted; the host beside a web link is
 * the one part of the link the person can trust, so nothing the model writes
 * in the label may change how the host reads.
 */

afterEach(cleanup);

/** Bidi embeddings, overrides and isolates: each can reorder the text after it. */
const BIDI_CONTROL = /[\u202A-\u202E\u2066-\u2069]/;

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

const answer = (text: string): AskAnswerView => {
  const blocks = citeAnswer(text);
  return { kind: 'answer', id: 'a', text, blocks, uncited: uncitedCount(blocks), checked: true };
};

function show(text: string) {
  const state: ChatPanelState = {
    items: [answer(text)],
    busy: false,
    error: null,
    context: null,
    notice: null,
  };
  render(
    <ChatPanel
      state={state}
      model="claude-opus-5-5"
      problem={null}
      history={{ chats: [], open: false, onOpenChange: vi.fn(), onPick: vi.fn(), problem: null }}
      actions={actions()}
      loadImage={async () => null}
    />,
  );
  return within(screen.getByRole('region', { name: 'Answer' }));
}

describe('the sidebar draws a web link (attack, PR #557)', () => {
  it('keeps a right-to-left override in the label from reversing the host shown beside it', () => {
    // U+202E in the label: without isolation, " (moc.elgoog.evil.example)"
    // is drawn reversed after it, and the host reads as something it is not.
    const reply = show('Pay here: [Larkspur billing\u202E](https://moc.elgoog.evil.example/pay).');
    const link = reply.getByRole('link');
    const host = link.querySelector('.ask__host');
    expect(host?.textContent).toContain('moc.elgoog.evil.example');

    const labelIsolated = [...link.querySelectorAll('bdi, [dir]')].some(
      (el) => !el.contains(host) && BIDI_CONTROL.test(el.textContent ?? ''),
    );
    const labelText = (link.textContent ?? '').replace(host?.textContent ?? '', '');
    expect(labelIsolated || !BIDI_CONTROL.test(labelText)).toBe(true);
  });
});
