// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { act, cleanup, render, renderHook, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SkillDraft } from '@dfai/domain';
import {
  ChatCancelled,
  ModelProviderError,
  type ModelEvent,
  type ModelProvider,
  type ModelRequest,
  type ProviderStatus,
} from '@dfai/application';
import { SkillsPage, type SkillEditorState } from '@dfai/ui';
import { useSkillDraft } from './use-skill-draft.ts';

afterEach(cleanup);

const SAVED: SkillDraft = {
  name: 'meeting-notes',
  description: 'Summarises meeting notes for Mara Quill.',
  instructions: 'List the decisions.\nList everything else said.',
};

const SHORTER = {
  name: 'meeting-notes',
  description: 'Summarises meeting notes.',
  instructions: 'List the decisions.',
};

/**
 * A model whose each answer is handed over by the test. Told to stop, it
 * stops; a `deaf` one answers anyway, as a provider that ignores the signal
 * might. `settle` waits until every answer handed over has been read.
 */
function heldModel(status: ProviderStatus = { ready: true }, { deaf = false } = {}) {
  const requests: ModelRequest[] = [];
  const answers: ((text: string) => void)[] = [];
  let stopped = 0;
  let given = 0;
  let read = 0;
  const provider: ModelProvider = {
    id: 'claude-code',
    status: async () => status,
    async *stream(request, signal): AsyncIterable<ModelEvent> {
      requests.push(request);
      try {
        const text = await new Promise<string>((resolve, reject) => {
          answers.push(resolve);
          signal.addEventListener('abort', () => {
            stopped += 1;
            if (!deaf) reject(new ChatCancelled());
          });
        });
        yield { type: 'text', text };
      } finally {
        read += 1;
      }
    },
  };
  return {
    provider,
    requests,
    stopped: () => stopped,
    answer: async (value: unknown) => {
      await vi.waitFor(() => expect(answers.length).toBeGreaterThan(0));
      given += 1;
      answers.shift()?.(typeof value === 'string' ? value : JSON.stringify(value));
    },
    /** Every answer given has been read, and what the page does with it is done. */
    settle: async () => {
      await vi.waitFor(() => expect(read).toBeGreaterThanOrEqual(given));
      // One task later every promise the answer started has run its course.
      await act(() => new Promise((done) => setTimeout(done, 0)));
    },
  };
}

function editorOf(mode: 'new' | 'edit', draft: SkillDraft): SkillEditorState {
  return {
    mode,
    draft,
    problems: [],
    fileProblems: [],
    descriptionLength: draft.description.length,
    descriptionLimit: 1024,
    changedOnDisk: false,
    saving: false,
    canSave: true,
    justCreated: false,
    saveRefusal: null,
    deleting: false,
  };
}

const BLANK: SkillDraft = { name: '', description: '', instructions: '' };

/**
 * The Skills page's editor and Ask Claude, with the editor's draft held as
 * the page holds it, and New opening a fresh new skill as the page does.
 */
function Harness({
  provider,
  mode: startMode,
  start,
  onSave,
  onChanged,
}: {
  provider: ModelProvider;
  mode: 'new' | 'edit';
  start: SkillDraft;
  onSave: () => void;
  onChanged: (change: Partial<SkillDraft>) => void;
}) {
  const [{ mode, draft, opening }, setShown] = useState({
    mode: startMode,
    draft: start,
    opening: 1,
  });
  const editor = editorOf(mode, draft);
  const onChange = (change: Partial<SkillDraft>) => {
    onChanged(change);
    setShown((was) => ({ ...was, draft: { ...was.draft, ...change } }));
  };
  const ask = useSkillDraft({
    ports: { provider: () => provider, model: () => 'claude-opus-5-5' },
    editor,
    opening,
    onChange,
  });
  return (
    <SkillsPage
      skills={{ items: [], error: null }}
      prompts={{ items: [], error: null }}
      selected={mode === 'edit' ? draft.name : null}
      editor={editor}
      notice={null}
      deleteQuestion={null}
      discardQuestion={null}
      focusTarget={null}
      onFocused={() => {}}
      onSelect={() => {}}
      onNew={() => setShown((was) => ({ mode: 'new', draft: BLANK, opening: was.opening + 1 }))}
      onChange={onChange}
      onSave={onSave}
      onDelete={() => {}}
      onReload={() => {}}
      onClose={() => {}}
      onOpenPrompt={() => {}}
      {...(ask !== undefined && { ask })}
    />
  );
}

function setUp({
  mode = 'edit' as 'new' | 'edit',
  start = SAVED,
  status,
  deaf = false,
}: { mode?: 'new' | 'edit'; start?: SkillDraft; status?: ProviderStatus; deaf?: boolean } = {}) {
  const model = heldModel(status, { deaf });
  const onSave = vi.fn();
  const onChanged = vi.fn();
  render(
    <Harness
      provider={model.provider}
      mode={mode}
      start={start}
      onSave={onSave}
      onChanged={onChanged}
    />,
  );
  return { model, onSave, onChanged };
}

const field = (name: RegExp | string) =>
  screen.getByRole('textbox', { name }) as HTMLInputElement | HTMLTextAreaElement;

async function askFor(request: string) {
  await userEvent.click(screen.getByRole('button', { name: 'Ask Claude…' }));
  await userEvent.type(field('What should Claude do?'), request);
  await userEvent.click(screen.getByRole('button', { name: 'Ask' }));
}

describe('Ask Claude on the Skills page', () => {
  it('previews the draft against the editor, and Accept fills the fields without saving', async () => {
    const { model, onSave } = setUp();
    await askFor('Make this shorter');
    expect(screen.getByRole('status').textContent).toBe('Asking Claude…');
    expect(model.requests[0]?.messages).toEqual([{ role: 'user', text: 'Make this shorter' }]);
    expect(model.requests[0]?.tools).toEqual([]);
    await model.answer(SHORTER);

    const draft = await screen.findByRole('region', { name: 'Claude’s draft' });
    const instructions = within(draft).getByRole('group', { name: 'Instructions' });
    expect(
      within(instructions)
        .getAllByRole('listitem')
        .map((line) => line.textContent),
    ).toEqual(['Unchanged: List the decisions.', 'Removed: List everything else said.']);
    const description = within(draft).getByRole('group', { name: 'Description' });
    expect(
      within(description)
        .getAllByRole('listitem')
        .map((line) => line.textContent),
    ).toEqual([`Removed: ${SAVED.description}`, `Added: ${SHORTER.description}`]);
    // Nothing reaches the editor before Accept.
    expect(field(/^Description/).value).toBe(SAVED.description);

    await userEvent.click(within(draft).getByRole('button', { name: 'Accept' }));
    expect(field(/^Description/).value).toBe(SHORTER.description);
    expect(field(/^Instructions/).value).toBe(SHORTER.instructions);
    expect(screen.queryByRole('region', { name: 'Ask Claude' })).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('Discard leaves the editor as it was', async () => {
    const { model } = setUp();
    await askFor('Make this shorter');
    await model.answer(SHORTER);
    await userEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    expect(field(/^Description/).value).toBe(SAVED.description);
    expect(field(/^Instructions/).value).toBe(SAVED.instructions);
    expect(screen.queryByRole('region', { name: 'Claude’s draft' })).toBeNull();
  });

  it('Ask again asks with the request as it now reads, and shows the new draft', async () => {
    const { model } = setUp();
    await askFor('Make this shorter');
    await model.answer(SHORTER);
    await screen.findByRole('region', { name: 'Claude’s draft' });
    await userEvent.type(field('What should Claude do?'), ' still');
    await userEvent.click(screen.getByRole('button', { name: 'Ask again' }));
    expect(model.requests[1]?.messages).toEqual([
      { role: 'user', text: 'Make this shorter still' },
    ]);
    await model.answer({ ...SHORTER, instructions: 'Decisions only.' });
    const draft = await screen.findByRole('region', { name: 'Claude’s draft' });
    expect(within(draft).getByText('Decisions only.')).toBeTruthy();
  });

  it('Stop cancels the ask: no draft comes, and nothing in the editor changes', async () => {
    const { model } = setUp();
    await askFor('Make this shorter');
    await vi.waitFor(() => expect(model.requests).toHaveLength(1));
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(model.stopped()).toBe(1);
    await model.answer(SHORTER);
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Ask' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Claude’s draft' })).toBeNull();
    expect(field(/^Description/).value).toBe(SAVED.description);
  });

  it('a bad answer is said, and changes nothing', async () => {
    const { model } = setUp();
    await askFor('Make this shorter');
    await model.answer({ ...SHORTER, description: 'd'.repeat(1025) });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Claude’s draft cannot be used:');
    expect(alert.textContent).toContain('at most 1024 characters');
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
    expect(field(/^Description/).value).toBe(SAVED.description);
  });

  it('says that a renamed draft keeps the skill’s name', async () => {
    const { model } = setUp();
    await askFor('Rename it');
    await model.answer({ ...SHORTER, name: 'meeting-summary' });
    const draft = await screen.findByRole('region', { name: 'Claude’s draft' });
    expect(draft.textContent).toContain('Claude named it “meeting-summary”');
    await userEvent.click(within(draft).getByRole('button', { name: 'Accept' }));
    expect(field('Name').value).toBe('meeting-notes');
  });

  it('drafts a new skill from nothing, and Accept fills its name too', async () => {
    const blank = { name: '', description: '', instructions: '' };
    const { model } = setUp({ mode: 'new', start: blank });
    await askFor('Draft a skill that summarises meeting notes');
    expect(model.requests[0]?.system).not.toContain('<vault_data kind');
    await model.answer({ ...SHORTER, name: 'standup-notes' });
    const draft = await screen.findByRole('region', { name: 'Claude’s draft' });
    expect(within(draft).getByText('standup-notes')).toBeTruthy();
    await userEvent.click(within(draft).getByRole('button', { name: 'Accept' }));
    expect(field('Name').value).toBe('standup-notes');
    expect(field(/^Instructions/).value).toBe(SHORTER.instructions);
  });

  it('says why Claude cannot be reached in the provider’s words, and asks nothing', async () => {
    const { model } = setUp({
      status: {
        ready: false,
        problem: 'not_installed',
        message: 'Claude Code is not installed.',
        fix: 'npm install -g @anthropic-ai/claude-code',
      },
    });
    await askFor('Make this shorter');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Claude Code is not installed.');
    expect(within(alert).getByText('npm install -g @anthropic-ai/claude-code')).toBeTruthy();
    expect(model.requests).toHaveLength(0);
  });

  function hooked(model: ReturnType<typeof heldModel>) {
    const ports = { provider: () => model.provider, model: () => 'claude-opus-5-5' };
    const onChange = vi.fn();
    const view = renderHook(
      ({ opening }: { opening: number }) =>
        useSkillDraft({ ports, editor: editorOf('edit', SAVED), opening, onChange }),
      { initialProps: { opening: 1 } },
    );
    const askNow = async () => {
      act(() => view.result.current?.onOpen());
      act(() => view.result.current?.onRequestChange('Make this shorter'));
      act(() => view.result.current?.onAsk());
      await vi.waitFor(() => expect(model.requests).toHaveLength(1));
    };
    return { ...view, onChange, askNow };
  }

  it('opening another editor stops the ask under way and forgets it', async () => {
    const model = heldModel();
    const { result, rerender, askNow } = hooked(model);
    await askNow();
    rerender({ opening: 2 });
    expect(model.stopped()).toBe(1);
    expect(result.current).toMatchObject({
      open: false,
      request: '',
      asking: false,
      preview: null,
    });
  });

  it('an ask on a new skill does not survive New: its answer never reaches the next one', async () => {
    const typed = { name: 'standup-notes', description: 'Tidies standups.', instructions: 'Tidy.' };
    const { model, onChanged } = setUp({ mode: 'new', start: typed, deaf: true });
    await askFor('Make this shorter');
    await vi.waitFor(() => expect(model.requests).toHaveLength(1));
    await userEvent.click(screen.getByRole('button', { name: 'New skill' }));
    expect(model.stopped()).toBe(1);
    await model.answer({ ...SHORTER, name: 'standup-notes' });
    await model.settle();
    expect(screen.queryByRole('region', { name: 'Ask Claude' })).toBeNull();
    expect(field('Name').value).toBe('');
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('a late answer after Stop shows no draft and changes nothing', async () => {
    const { model, onChanged } = setUp({ deaf: true });
    await askFor('Make this shorter');
    await vi.waitFor(() => expect(model.requests).toHaveLength(1));
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await model.answer(SHORTER);
    await model.settle();
    expect(screen.getByRole('button', { name: 'Ask' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Claude’s draft' })).toBeNull();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('a stopped ask answering late does not end the ask made after it', async () => {
    const { model } = setUp({ deaf: true });
    await askFor('Make this shorter');
    await vi.waitFor(() => expect(model.requests).toHaveLength(1));
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await vi.waitFor(() => expect(model.requests).toHaveLength(2));
    await model.answer(SHORTER);
    await model.settle();
    expect(screen.getByRole('status').textContent).toBe('Asking Claude…');
    await model.answer({ ...SHORTER, instructions: 'Decisions only.' });
    const draft = await screen.findByRole('region', { name: 'Claude’s draft' });
    expect(within(draft).getByText('Decisions only.')).toBeTruthy();
  });

  it('a late answer after Close, or after the page has gone, changes nothing', async () => {
    const closing = heldModel(undefined, { deaf: true });
    const closed = hooked(closing);
    await closed.askNow();
    act(() => closed.result.current?.onClose());
    expect(closing.stopped()).toBe(1);
    await closing.answer(SHORTER);
    await closing.settle();
    expect(closed.result.current).toMatchObject({ open: false, asking: false, preview: null });
    expect(closed.onChange).not.toHaveBeenCalled();

    const leaving = heldModel(undefined, { deaf: true });
    const gone = hooked(leaving);
    await gone.askNow();
    gone.unmount();
    expect(leaving.stopped()).toBe(1);
    await leaving.answer(SHORTER);
    await leaving.settle();
    expect(gone.onChange).not.toHaveBeenCalled();
  });

  it('typing while Claude is asked shows in the preview, and Accept gives the draft', async () => {
    const { model } = setUp();
    await askFor('Make this shorter');
    await userEvent.type(field(/^Description/), ' Typed meanwhile.');
    await model.answer(SHORTER);
    const draft = await screen.findByRole('region', { name: 'Claude’s draft' });
    const description = within(draft).getByRole('group', { name: 'Description' });
    expect(
      within(description)
        .getAllByRole('listitem')
        .map((line) => line.textContent),
    ).toEqual([`Removed: ${SAVED.description} Typed meanwhile.`, `Added: ${SHORTER.description}`]);
    await userEvent.click(within(draft).getByRole('button', { name: 'Accept' }));
    expect(field(/^Description/).value).toBe(SHORTER.description);
  });

  it('says a failure in its own words, as the chat does', async () => {
    const broken: ModelProvider = {
      id: 'claude-code',
      status: async () => ({ ready: true }),
      // eslint-disable-next-line require-yield -- a stream that fails before its first word
      async *stream() {
        throw new ModelProviderError('failed', 'Claude Code could not answer: overloaded');
      },
    };
    const buggy: ModelProvider = {
      ...broken,
      // eslint-disable-next-line require-yield -- a stream that fails before its first word
      async *stream() {
        throw new TypeError('the host went away');
      },
    };
    for (const [provider, said] of [
      [broken, 'Claude Code could not answer: overloaded'],
      [buggy, 'the host went away'],
    ] as const) {
      cleanup();
      render(
        <Harness
          provider={provider}
          mode="edit"
          start={SAVED}
          onSave={vi.fn()}
          onChanged={vi.fn()}
        />,
      );
      await askFor('Make this shorter');
      const alert = await screen.findByRole('alert');
      expect(alert.querySelector('p')?.textContent).toBe(said);
    }
  });
});
