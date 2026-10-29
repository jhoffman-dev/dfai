// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { act, cleanup, render, renderHook, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SkillDraft } from '@dfai/domain';
import {
  ChatCancelled,
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

/** A model whose each answer is handed over by the test, and which stops when told. */
function heldModel(status: ProviderStatus = { ready: true }) {
  const requests: ModelRequest[] = [];
  const answers: ((text: string) => void)[] = [];
  let stopped = 0;
  const provider: ModelProvider = {
    id: 'claude-code',
    status: async () => status,
    async *stream(request, signal): AsyncIterable<ModelEvent> {
      requests.push(request);
      const text = await new Promise<string>((resolve, reject) => {
        answers.push(resolve);
        signal.addEventListener('abort', () => {
          stopped += 1;
          reject(new ChatCancelled());
        });
      });
      yield { type: 'text', text };
    },
  };
  return {
    provider,
    requests,
    stopped: () => stopped,
    answer: async (value: unknown) => {
      await vi.waitFor(() => expect(answers.length).toBeGreaterThan(0));
      answers.shift()?.(typeof value === 'string' ? value : JSON.stringify(value));
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

/** The Skills page's editor and Ask Claude, with the editor's draft held as the page holds it. */
function Harness({
  provider,
  mode,
  start,
  onSave,
}: {
  provider: ModelProvider;
  mode: 'new' | 'edit';
  start: SkillDraft;
  onSave: () => void;
}) {
  const [draft, setDraft] = useState(start);
  const editor = editorOf(mode, draft);
  const onChange = (change: Partial<SkillDraft>) => setDraft((was) => ({ ...was, ...change }));
  const ask = useSkillDraft({
    ports: { provider: () => provider, model: () => 'claude-opus-5-5' },
    editor,
    selected: mode === 'edit' ? draft.name : null,
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
      onNew={() => {}}
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
}: { mode?: 'new' | 'edit'; start?: SkillDraft; status?: ProviderStatus } = {}) {
  const model = heldModel(status);
  const onSave = vi.fn();
  render(<Harness provider={model.provider} mode={mode} start={start} onSave={onSave} />);
  return { model, onSave };
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

  it('opening another skill stops the ask under way and forgets it', async () => {
    const model = heldModel();
    const ports = { provider: () => model.provider, model: () => 'claude-opus-5-5' };
    const onChange = vi.fn();
    const { result, rerender } = renderHook(
      ({ selected }: { selected: string }) =>
        useSkillDraft({
          ports,
          editor: editorOf('edit', { ...SAVED, name: selected }),
          selected,
          onChange,
        }),
      { initialProps: { selected: 'meeting-notes' } },
    );
    act(() => result.current?.onOpen());
    act(() => result.current?.onRequestChange('Make this shorter'));
    act(() => result.current?.onAsk());
    await vi.waitFor(() => expect(model.requests).toHaveLength(1));
    rerender({ selected: 'weekly-review' });
    expect(model.stopped()).toBe(1);
    expect(result.current).toMatchObject({
      open: false,
      request: '',
      asking: false,
      preview: null,
    });
  });
});
