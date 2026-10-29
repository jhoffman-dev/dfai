import { describe, expect, it } from 'vitest';
import { createVaultPath, EMPTY_PROFILE, type ProfileState, type ToolCall } from '@dfai/domain';
import { apiFixture, TODAY } from '../testing/api-fixture.ts';
import { blockMarkdown } from '../testing/block-markdown.ts';
import { recordingActivity } from '../testing/fake-activity.ts';
import { fakeModel, type ScriptedRound } from '../testing/fake-model.ts';
import { createChatSession, type ChatItem } from './chat-session.ts';
import type { SkillToUse } from '../skills/skill-to-use.ts';
import { VaultAccessError } from '../vault/ports.ts';
import { ModelProviderError } from './ports.ts';
import { acceptProposal, undoProposal } from './proposals.ts';
import { createChatToolbox } from './toolbox.ts';

const PLAN = 'Intro.\n\n- [ ] Call Sam\n';
const READ: ToolCall = { id: 'call-1', name: 'atlas_read_note', input: { path: 'Plan.md' } };
const EDIT: ToolCall = {
  id: 'call-2',
  name: 'propose_edit',
  input: { path: 'Plan.md', edits: [{ find: '- [ ] Call Sam', replace: '- [x] Call Sam' }] },
};

function session(
  rounds: ScriptedRound[],
  {
    vaultOpen = true,
    profile = () => Promise.resolve(EMPTY_PROFILE),
    skill = () => Promise.resolve({ kind: 'missing' }),
  }: {
    vaultOpen?: boolean;
    profile?: () => Promise<ProfileState>;
    skill?: (name: string) => Promise<SkillToUse>;
  } = {},
) {
  const fixture = apiFixture({ files: { 'Plan.md': PLAN }, markdown: blockMarkdown() });
  const markdown = blockMarkdown();
  const model = fakeModel(rounds);
  let ids = 0;
  const newId = () => `id-${(ids += 1)}`;
  const openNotes = { state: () => 'closed' as const, reload: () => {} };
  const activity = recordingActivity();
  const chat = createChatSession({
    provider: () => model,
    model: () => 'claude-opus-5-5',
    profile,
    toolbox: () =>
      vaultOpen ? createChatToolbox({ api: fixture.deps, fs: fixture.fs, markdown, newId }) : null,
    clock: { today: () => TODAY, now: () => 0, localNow: () => `${TODAY}T09:00:00` },
    vault: () => (vaultOpen ? { fs: fixture.fs, notePaths: [] } : null),
    accept: (proposal) => acceptProposal({ fs: fixture.fs, openNotes, proposal }),
    undo: (applied) => undoProposal({ fs: fixture.fs, openNotes, applied }),
    skill,
    stamp: () => '2026-09-22 09:00',
    newId,
    activity,
  });
  return { chat, fixture, model, activity };
}

const kinds = (items: readonly ChatItem[]) => items.map((item) => item.kind);
const proposalOf = (items: readonly ChatItem[]) => {
  const found = items.find((item) => item.kind === 'proposal');
  if (found?.kind !== 'proposal') throw new Error('no proposal in the transcript');
  return found;
};

describe('a chat session, and who the person is', () => {
  it('tells the model the name Settings → Profile holds, read when the question is asked', async () => {
    let name: string | null = 'Ada Lovelace';
    const { chat, model } = session(
      [[{ type: 'text', text: 'Hi.' }], [{ type: 'text', text: 'Hi again.' }]],
      { profile: () => Promise.resolve({ name, preferredName: null }) },
    );

    await chat.send('Who am I?');
    name = 'James Hoffman';
    await chat.send('And now?');

    expect(model.requests[0]?.system).toContain('Full name: Ada Lovelace\n');
    expect(model.requests[1]?.system).toContain('Full name: James Hoffman\n');
  });

  it('with no name, tells the model to write the placeholder rather than guess', async () => {
    const { chat, model } = session([[{ type: 'text', text: 'Noted.' }]]);
    await chat.send('Make me a meeting note');
    expect(model.requests[0]?.system).toContain('has not told DFAI their name');
    expect(model.requests[0]?.system).toContain('[Your name]');
  });

  it('waits for the profile before asking, so a name still being read is not sent as none', async () => {
    let settle: (profile: ProfileState) => void = () => {};
    const read = new Promise<ProfileState>((resolve) => (settle = resolve));
    const { chat, model } = session([[{ type: 'text', text: 'Hi, Ada.' }]], {
      profile: () => read,
    });

    const sent = chat.send('Who am I?');
    await Promise.resolve();
    expect(model.requests).toHaveLength(0);
    expect(chat.state().busy).toBe(true);

    settle({ name: 'Ada Lovelace', preferredName: null });
    await sent;
    expect(model.requests[0]?.system).toContain('Full name: Ada Lovelace\n');
  });

  it('a profile it could not read is sent as unknown: ask, do not write a placeholder', async () => {
    const { chat, model } = session([[{ type: 'text', text: 'What is your name?' }]], {
      profile: () => Promise.resolve('unknown'),
    });
    await chat.send('Make me a meeting note');
    expect(model.requests[0]?.system).toContain("DFAI couldn't read the person's name");
    expect(model.requests[0]?.system).not.toContain('has not told DFAI their name');
  });

  it('a new chat started while the profile is read sends nothing', async () => {
    let settle: (profile: ProfileState) => void = () => {};
    const read = new Promise<ProfileState>((resolve) => (settle = resolve));
    const { chat, model } = session([[{ type: 'text', text: 'Hi.' }]], { profile: () => read });

    const sent = chat.send('Who am I?');
    chat.newChat();
    settle(EMPTY_PROFILE);
    await sent;
    expect(model.requests).toHaveLength(0);
    expect(chat.state().busy).toBe(false);
  });
});

describe('a chat session', () => {
  it('asks with the context, shows the tool it ran, and keeps the turn in Chats/', async () => {
    const { chat, fixture, model } = session([
      [{ type: 'tool_call', call: READ }],
      [{ type: 'text', text: 'It is a plan.' }],
    ]);
    chat.offerContext({ kind: 'note', title: 'Plan', path: createVaultPath('Plan.md'), text: 'x' });

    await chat.send('What is this?');

    expect(kinds(chat.state().items)).toEqual(['user', 'tool', 'assistant']);
    expect(chat.state().items[1]).toMatchObject({ label: 'Read Plan.md', state: 'done' });
    expect(model.requests[0]?.system).toContain('<vault_data kind="note" title="Plan"');
    expect(model.requests[0]?.system).toContain(`Today is ${TODAY}.`);
    expect(chat.state().chatPath).toBe('Chats/What is this.md');
    expect(fixture.files.get('Chats/What is this.md')?.text).toContain(
      '## You\n\nWhat is this?\n\n## Claude\n\nIt is a plan.\n\n> Read Plan.md\n',
    );
  });

  it('says a refused proposal could not be made, and why, in the pane and in Chats/', async () => {
    const missing: ToolCall = {
      id: 'call-3',
      name: 'propose_edit',
      input: { path: 'Plan.md', edits: [{ find: 'Call Julie', replace: 'x' }] },
    };
    const { chat, fixture } = session([
      [{ type: 'tool_call', call: missing }],
      [{ type: 'text', text: 'Sorry.' }],
    ]);
    await chat.send('Tick off Julie');

    expect(kinds(chat.state().items)).toEqual(['user', 'tool', 'assistant']);
    expect(chat.state().items[1]).toMatchObject({
      label: 'Could not propose an edit to Plan.md',
      state: 'failed',
      detail: expect.stringContaining('no text "Call Julie"'),
    });
    expect(fixture.files.get('Chats/Tick off Julie.md')?.text).toContain(
      '\n> Could not propose an edit to Plan.md: The note has no text "Call Julie"',
    );
    expect(fixture.files.get('Chats/Tick off Julie.md')?.text).not.toContain('> Proposed an edit');
  });

  it('keeps words said before and after a tool as separate paragraphs', async () => {
    const { chat, fixture } = session([
      [
        { type: 'text', text: 'Looking.' },
        { type: 'tool_call', call: READ },
      ],
      [{ type: 'text', text: 'Done.' }],
    ]);
    await chat.send('Check');
    expect(kinds(chat.state().items)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(fixture.files.get('Chats/Check.md')?.text).toContain('## Claude\n\nLooking.\n\nDone.\n');
  });

  it('writes nothing to the note until Accept, then writes the edit; Undo puts it back', async () => {
    const { chat, fixture } = session([
      [{ type: 'tool_call', call: EDIT }],
      [{ type: 'text', text: 'Proposed.' }],
    ]);
    await chat.send('Tick off Sam');
    const pending = proposalOf(chat.state().items);
    expect(pending.state).toBe('pending');
    expect(fixture.files.get('Plan.md')?.text).toBe(PLAN);

    await chat.accept(pending.id);
    expect(proposalOf(chat.state().items).state).toBe('accepted');
    expect(fixture.files.get('Plan.md')?.text).toBe('Intro.\n\n- [x] Call Sam\n');

    await chat.undo(pending.id);
    expect(proposalOf(chat.state().items).state).toBe('undone');
    expect(fixture.files.get('Plan.md')?.text).toBe(PLAN);
  });

  it('leaves the note as it was on Reject, and tells the model with the next question', async () => {
    const { chat, fixture, model } = session([
      [{ type: 'tool_call', call: EDIT }],
      [{ type: 'text', text: 'Proposed.' }],
      [{ type: 'text', text: 'Fine.' }],
    ]);
    await chat.send('Tick off Sam');
    chat.reject(proposalOf(chat.state().items).id);
    expect(proposalOf(chat.state().items).state).toBe('rejected');
    await chat.accept(proposalOf(chat.state().items).id);
    expect(fixture.files.get('Plan.md')?.text).toBe(PLAN);

    await chat.send('ok');
    expect(model.requests[2]?.messages.at(-1)).toEqual({
      role: 'user',
      text: '(The person rejected: the proposed edit to Plan.md.)\n\nok',
    });
  });

  it('shows why an Accept was refused and keeps the proposal open', async () => {
    const { chat, fixture } = session([
      [{ type: 'tool_call', call: EDIT }],
      [{ type: 'text', text: 'Proposed.' }],
    ]);
    await chat.send('Tick off Sam');
    await fixture.fs.writeTextFile({
      path: createVaultPath('Plan.md'),
      contents: 'Changed.\n',
      expectedModified: null,
    });
    await chat.accept(proposalOf(chat.state().items).id);
    expect(proposalOf(chat.state().items)).toMatchObject({
      state: 'pending',
      problem: expect.stringContaining('changed since'),
    });
  });

  it('shows a provider failure, and Retry asks the same question again', async () => {
    const { chat, model } = session([
      new ModelProviderError('not_logged_in', 'Claude Code is installed but not logged in.'),
      [{ type: 'text', text: 'Now it works.' }],
    ]);
    await chat.send('Hello');
    expect(chat.state().error).toEqual({
      message: 'Claude Code is installed but not logged in.',
      problem: 'not_logged_in',
    });

    await chat.retry();
    expect(chat.state().error).toBeNull();
    expect(kinds(chat.state().items)).toEqual(['user', 'assistant']);
    expect(model.requests[1]?.messages).toEqual([{ role: 'user', text: 'Hello' }]);
  });

  it('stops when asked, keeping what had arrived', async () => {
    const { chat } = session([
      async function* () {
        yield { type: 'text', text: 'Partly' } as const;
        chat.stop();
        yield { type: 'text', text: ' more' } as const;
      },
    ]);
    await chat.send('Go');
    expect(chat.state().busy).toBe(false);
    expect(chat.state().items.at(-1)).toMatchObject({ kind: 'assistant', text: 'Partly' });
  });

  it('keeps the context it opened with once something is asked, and drops it when removed', async () => {
    const { chat } = session([[{ type: 'text', text: 'Hi' }]]);
    const first = { kind: 'note', title: 'A', path: null, text: 'a' } as const;
    chat.offerContext(first);
    await chat.send('Hi');
    chat.offerContext({ ...first, title: 'B' });
    expect(chat.state().context?.title).toBe('A');
    chat.removeContext();
    expect(chat.state().context).toBeNull();
    chat.newChat();
    chat.offerContext(first);
    expect(chat.state().context?.title).toBe('A');
    expect(chat.state().items).toEqual([]);
  });

  it('reopens a past chat from its note', async () => {
    const { chat, model } = session([[{ type: 'text', text: 'Again.' }]]);
    await chat.send('ignored');
    const path = chat.state().chatPath;
    expect(path).not.toBeNull();
    chat.newChat();
    await chat.open(path ?? createVaultPath('x.md'));
    expect(
      chat
        .state()
        .items.map((item) => (item.kind === 'user' || item.kind === 'assistant' ? item.text : '')),
    ).toEqual(['ignored', 'Again.']);
    expect(model.requests).toHaveLength(1);
  });

  it('says to open a vault when there is none, and ignores a blank question', async () => {
    const { chat } = session([], { vaultOpen: false });
    await chat.send('   ');
    expect(chat.state().items).toEqual([]);
    await chat.send('Hi');
    expect(chat.state().error?.message).toBe('Open a vault to chat about it.');
  });
});

describe('a chat session in the Activity log', () => {
  const proposing = (): ScriptedRound[] => [
    [{ type: 'tool_call', call: EDIT }],
    [{ type: 'text', text: 'Proposed.' }],
  ];

  it('records an Accept and an Undo, linked to the note, never the chat or the edit', async () => {
    const { chat, activity } = session(proposing());
    await chat.send('Tick off Sam, my secret question');
    const { id } = proposalOf(chat.state().items);
    await chat.accept(id);
    await chat.undo(id);
    expect(activity.reports).toEqual([
      {
        level: 'info',
        kind: 'chat',
        message: 'Edited Plan, as Claude proposed.',
        subject: { kind: 'note', path: 'Plan.md' },
      },
      {
        level: 'info',
        kind: 'chat',
        message: "Undid Claude's change to Plan.",
        subject: { kind: 'note', path: 'Plan.md' },
      },
    ]);
    const said = JSON.stringify(activity.reports);
    expect(said).not.toContain('secret question');
    expect(said).not.toContain('Call Sam');
  });

  it('records a refused Accept as a warning', async () => {
    const { chat, fixture, activity } = session(proposing());
    await chat.send('Tick off Sam');
    await fixture.fs.writeTextFile({
      path: createVaultPath('Plan.md'),
      contents: 'Changed.\n',
      expectedModified: null,
    });
    await chat.accept(proposalOf(chat.state().items).id);
    expect(activity.reports).toHaveLength(1);
    expect(activity.reports[0]).toMatchObject({ level: 'warning', kind: 'chat' });
    expect(activity.reports[0]?.message).toMatch(/^Could not accept Claude's change to Plan\. /);
  });

  it('records a refused Undo as a warning', async () => {
    const { chat, fixture, activity } = session(proposing());
    await chat.send('Tick off Sam');
    const { id } = proposalOf(chat.state().items);
    await chat.accept(id);
    await fixture.fs.writeTextFile({
      path: createVaultPath('Plan.md'),
      contents: 'Edited again.\n',
      expectedModified: null,
    });
    await chat.undo(id);
    expect(activity.reports.at(-1)).toMatchObject({ level: 'warning', kind: 'chat' });
    expect(activity.reports.at(-1)?.message).toMatch(/^Could not undo Claude's change to Plan\. /);
  });

  it('records a turn that failed, with why and not what was asked', async () => {
    const { chat, activity } = session([
      new ModelProviderError('not_logged_in', 'Claude Code is installed but not logged in.'),
    ]);
    await chat.send('What is in my private diary?');
    expect(activity.reports).toEqual([
      {
        level: 'error',
        kind: 'chat',
        // Fixed words for the kind (A28-01): the provider's own text never reaches the log.
        message: 'Claude could not answer: Claude Code is not signed in.',
        subject: null,
      },
    ]);
  });

  it('records a failed turn without the question, even when the provider quoted it back', async () => {
    // Claude Code exits non-zero and its stderr quotes the prompt it was given.
    const { chat, activity } = session([
      new ModelProviderError(
        'failed',
        'Claude Code could not answer: Error: invalid prompt "What is in my private diary?"',
      ),
    ]);
    await chat.send('What is in my private diary?');
    expect(activity.reports).toHaveLength(1);
    expect(activity.reports[0]?.message).not.toContain('private diary');
  });

  it('records nothing for a turn the person stopped, even one that ends in an error', async () => {
    const { chat, activity } = session([
      async function* () {
        yield { type: 'text', text: 'Partly' } as const;
        chat.stop();
        // What a provider's stream does once its request is cut off.
        throw new Error('The operation was aborted.');
      },
    ]);
    await chat.send('Go');
    expect(chat.state().busy).toBe(false);
    expect(chat.state().error?.message).toBe('The operation was aborted.');
    expect(activity.reports).toEqual([]);
  });

  it('records a chat note that could not be saved', async () => {
    const { chat, fixture, activity } = session([[{ type: 'text', text: 'Hi' }]]);
    fixture.open = null;
    await chat.send('Hello');
    expect(chat.state().notice).not.toBeNull();
    expect(activity.reports).toHaveLength(1);
    expect(activity.reports[0]).toMatchObject({ level: 'error', kind: 'chat' });
    expect(activity.reports[0]?.message).toBe('The chat could not be saved to Chats/.');
  });

  it("records an unsaved chat in fixed words, never the error's, which name the note after the question", async () => {
    const question = 'Should Tobias Fenn be promoted this spring';
    const { chat, fixture, activity } = session([[{ type: 'text', text: 'Perhaps.' }]]);
    let tried: string | null = null;
    fixture.fs.createNote = async ({ path }) => {
      tried = path;
      throw new Error(`${path} could not be written: the disk is full`);
    };
    await chat.send(question);
    expect(tried).toContain('Tobias Fenn');
    expect(chat.state().notice).toContain('the disk is full');
    expect(activity.reports).toHaveLength(1);
    const { message } = activity.reports[0] ?? { message: '' };
    expect(message).toBe('The chat could not be saved to Chats/.');
    expect(message).not.toContain('Tobias');
    expect(message).not.toContain(tried);
  });
});

describe('a chat session, and the skill the person attached (#169)', () => {
  const REVIEW = 'Group what Mara Quill finished by project.';
  /** Skills as the vault holds them now: changed between turns as a person edits one. */
  function skills(initial: Record<string, SkillToUse>) {
    const held = new Map(Object.entries(initial));
    const reads: string[] = [];
    return {
      held,
      reads,
      port: (name: string) => {
        reads.push(name);
        return Promise.resolve(held.get(name) ?? ({ kind: 'missing' } as const));
      },
    };
  }
  const usable = (instructions: string): SkillToUse => ({
    kind: 'usable',
    name: 'weekly-review',
    instructions,
  });

  it('asks with the skill after DFAI’s rules, says so in the chat note, and leaves it out once removed', async () => {
    const vault = skills({ 'weekly-review': usable(REVIEW) });
    const { chat, model, fixture } = session(
      [[{ type: 'text', text: 'Reviewed.' }], [{ type: 'text', text: 'Plain.' }]],
      { skill: vault.port },
    );

    await chat.attachSkill('weekly-review');
    expect(chat.state().skill).toEqual({ name: 'weekly-review', problem: null });
    await chat.send('Review my week');

    const system = model.requests[0]?.system ?? '';
    expect(system).toContain(`<chosen_skill name="weekly-review">\n${REVIEW}\n</chosen_skill>`);
    expect(system.indexOf('chosen_skill')).toBeGreaterThan(system.indexOf('Your tools only read.'));
    const chatPath = chat.state().chatPath;
    expect(chatPath).not.toBeNull();
    expect(fixture.files.get(chatPath ?? '')?.text).toContain('> Used the skill weekly-review');

    chat.removeSkill();
    expect(chat.state().skill).toBeNull();
    await chat.send('And without it?');
    expect(model.requests[1]?.system).not.toContain('chosen_skill');
    expect(model.requests[1]?.system).not.toContain(REVIEW);
  });

  it('reads the skill again for each turn, so an edit since applies', async () => {
    const vault = skills({ 'weekly-review': usable('First version.') });
    const { chat, model } = session(
      [[{ type: 'text', text: 'One.' }], [{ type: 'text', text: 'Two.' }]],
      { skill: vault.port },
    );
    await chat.attachSkill('weekly-review');
    await chat.send('Once');
    vault.held.set('weekly-review', usable('Second version.'));
    await chat.send('Twice');
    expect(model.requests[1]?.system).toContain('Second version.');
    expect(model.requests[1]?.system).not.toContain('First version.');
  });

  it('refuses a skill too long to hand over before Claude is asked, on the chip and in the chat', async () => {
    const tooLong: SkillToUse = {
      kind: 'unusable',
      message: 'Its instructions are 20001 characters.',
    };
    const vault = skills({ 'weekly-review': tooLong });
    const { chat, model } = session([[{ type: 'text', text: 'Never.' }]], { skill: vault.port });

    await chat.attachSkill('weekly-review');
    const refusal =
      'The skill weekly-review cannot be used: Its instructions are 20001 characters.';
    expect(chat.state().skill).toEqual({ name: 'weekly-review', problem: refusal });
    await chat.send('Review my week');

    expect(model.requests).toHaveLength(0);
    expect(chat.state().error?.message).toBe(refusal);
    expect(chat.state().busy).toBe(false);
    // The question stays, to retry once the skill is put right.
    expect(kinds(chat.state().items)).toEqual(['user']);
  });

  it('refuses a skill that became unusable since it was attached, and retries once it is put right', async () => {
    const vault = skills({ 'weekly-review': usable(REVIEW) });
    const { chat, model } = session([[{ type: 'text', text: 'Reviewed.' }]], {
      skill: vault.port,
    });
    await chat.attachSkill('weekly-review');
    vault.held.delete('weekly-review');
    await chat.send('Review my week');
    expect(model.requests).toHaveLength(0);
    expect(chat.state().skill?.problem).toBe('The skill weekly-review is not in .atlas/skills.');

    vault.held.set('weekly-review', usable(REVIEW));
    await chat.retry();
    expect(model.requests).toHaveLength(1);
    expect(chat.state().skill?.problem).toBeNull();
    expect(chat.state().error).toBeNull();
  });

  it('says a skill the host refused could not be read, in DFAI’s words', async () => {
    const { chat } = session([], {
      skill: () => Promise.reject(new VaultAccessError('/Users/mara/vault: permission denied')),
    });
    await chat.attachSkill('weekly-review');
    expect(chat.state().skill?.problem).toBe('The skill weekly-review could not be read.');
  });

  it('drops an attach read after the skill was removed, or a new chat begun', async () => {
    let finish: (found: SkillToUse) => void = () => {};
    const { chat } = session([], {
      skill: () => new Promise<SkillToUse>((resolve) => (finish = resolve)),
    });
    const attaching = chat.attachSkill('weekly-review');
    chat.removeSkill();
    finish(usable(REVIEW));
    await attaching;
    expect(chat.state().skill).toBeNull();

    const again = chat.attachSkill('weekly-review');
    chat.newChat();
    finish(usable(REVIEW));
    await again;
    expect(chat.state().skill).toBeNull();
  });

  it('starts a new chat without the skill', async () => {
    const vault = skills({ 'weekly-review': usable(REVIEW) });
    const { chat, model } = session([[{ type: 'text', text: 'Plain.' }]], { skill: vault.port });
    await chat.attachSkill('weekly-review');
    chat.newChat();
    await chat.send('Hello');
    expect(model.requests[0]?.system).not.toContain('chosen_skill');
  });

  it('reopens a past chat without its skill: a skill is not kept with a chat', async () => {
    const vault = skills({ 'weekly-review': usable(REVIEW) });
    const { chat } = session([[{ type: 'text', text: 'Reviewed.' }]], { skill: vault.port });
    await chat.attachSkill('weekly-review');
    await chat.send('Review my week');
    const kept = chat.state().chatPath;
    if (kept === null) throw new Error('the chat was not kept');
    expect(chat.state().skill?.name).toBe('weekly-review');
    await chat.open(kept);
    expect(chat.state().items.length).toBeGreaterThan(0);
    expect(chat.state().skill).toBeNull();
  });
});

describe('a chat session, and /name (#169)', () => {
  const REVIEW: SkillToUse = { kind: 'usable', name: 'weekly-review', instructions: 'Review.' };
  const port = (name: string): Promise<SkillToUse> =>
    Promise.resolve(name === 'weekly-review' ? REVIEW : { kind: 'missing' });

  it('attaches the skill /name names, and asks the question after it with it', async () => {
    const { chat, model } = session([[{ type: 'text', text: 'Done.' }]], { skill: port });
    await chat.send('/weekly-review What did I finish?');
    expect(chat.state().skill).toEqual({ name: 'weekly-review', problem: null });
    expect(chat.state().items[0]).toMatchObject({ kind: 'user', text: 'What did I finish?' });
    expect(model.requests[0]?.system).toContain('<chosen_skill name="weekly-review">');
  });

  it('only attaches when /name stands alone, asking nothing', async () => {
    const { chat, model } = session([], { skill: port });
    await chat.send('/weekly-review');
    expect(chat.state().skill?.name).toBe('weekly-review');
    expect(chat.state().items).toHaveLength(0);
    expect(model.requests).toHaveLength(0);
  });

  it('asks a /word that names no skill as the question it is', async () => {
    const { chat, model } = session([[{ type: 'text', text: 'Hm.' }]], { skill: port });
    await chat.send('/standup notes?');
    expect(chat.state().skill).toBeNull();
    expect(chat.state().items[0]).toMatchObject({ kind: 'user', text: '/standup notes?' });
    expect(model.requests[0]?.system).not.toContain('chosen_skill');
  });
});

describe('a chat session, and a skill read that is still under way (PR #635 review)', () => {
  const REVIEW: SkillToUse = { kind: 'usable', name: 'weekly-review', instructions: 'Review.' };
  /** A skill port whose reads are answered by hand, one at a time. */
  function heldSkills() {
    const waiting: ((found: SkillToUse) => void)[] = [];
    return {
      port: () => new Promise<SkillToUse>((resolve) => waiting.push(resolve)),
      answer: (found: SkillToUse) => waiting.shift()?.(found),
      pending: () => waiting.length,
    };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('keeps a chip taken off while a turn re-read it off, and asks that turn without it', async () => {
    const held = heldSkills();
    const { chat, model } = session([[{ type: 'text', text: 'Plain.' }]], { skill: held.port });
    const attaching = chat.attachSkill('weekly-review');
    held.answer(REVIEW);
    await attaching;

    const asking = chat.send('Review my week');
    await settle();
    expect(held.pending()).toBe(1);
    chat.removeSkill();
    held.answer(REVIEW);
    await asking;

    expect(chat.state().skill).toBeNull();
    expect(model.requests[0]?.system).not.toContain('chosen_skill');
  });

  it('drops a /name read once the chip was taken off meanwhile', async () => {
    const held = heldSkills();
    const { chat } = session([[{ type: 'text', text: 'Plain.' }]], { skill: held.port });
    const asking = chat.send('/weekly-review What did I finish?');
    chat.removeSkill();
    held.answer(REVIEW);
    await asking;
    expect(chat.state().skill).toBeNull();
  });

  it('drops a /name read once a new chat was begun meanwhile, and the new chat is empty', async () => {
    const held = heldSkills();
    const { chat, model } = session([[{ type: 'text', text: 'Never.' }]], { skill: held.port });
    const asking = chat.send('/weekly-review What did I finish?');
    chat.newChat();
    held.answer(REVIEW);
    await asking;
    expect(chat.state().skill).toBeNull();
    expect(chat.state().items).toEqual([]);
    expect(model.requests).toHaveLength(0);
  });

  it('shows a /name question at once, and is busy until it is asked: a second send waits its turn', async () => {
    const held = heldSkills();
    const { chat, model } = session(
      [[{ type: 'text', text: 'Reviewed.' }], [{ type: 'text', text: 'Second.' }]],
      { skill: held.port },
    );
    const asking = chat.send('/weekly-review What did I finish?');
    expect(chat.state().busy).toBe(true);
    expect(chat.state().items).toMatchObject([
      { kind: 'user', text: '/weekly-review What did I finish?' },
    ]);
    // Refused while busy, as a send during any answer is: the composer shows Stop, not Send.
    await chat.send('Something else');
    held.answer(REVIEW);
    held.answer(REVIEW);
    await asking;

    expect(chat.state().items[0]).toMatchObject({ kind: 'user', text: 'What did I finish?' });
    expect(chat.state().items.filter((item) => item.kind === 'user')).toHaveLength(1);
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]?.system).toContain('chosen_skill');
  });

  it('a past chat picked during a /name read does not take the question’s place', async () => {
    const held = heldSkills();
    const { chat } = session(
      [[{ type: 'text', text: 'Old answer.' }], [{ type: 'text', text: 'Reviewed.' }]],
      { skill: held.port },
    );
    await chat.send('An old question');
    const old = chat.state().chatPath;
    if (old === null) throw new Error('the chat was not kept');
    chat.newChat();
    const asking = chat.send('/weekly-review What did I finish?');
    const opening = chat.open(old);
    held.answer(REVIEW);
    held.answer(REVIEW);
    await Promise.allSettled([asking, opening]);
    expect(
      chat.state().items.some((item) => item.kind === 'user' && item.text === 'What did I finish?'),
    ).toBe(true);
  });

  it('takes away a /name that stands alone once read, asking nothing', async () => {
    const held = heldSkills();
    const { chat, model } = session([], { skill: held.port });
    const asking = chat.send('/weekly-review');
    held.answer(REVIEW);
    await asking;
    expect(chat.state().items).toEqual([]);
    expect(chat.state().busy).toBe(false);
    expect(model.requests).toHaveLength(0);
  });

  it('sends a /word as typed when the skills cannot be read, so no skill is shown to exist', async () => {
    const { chat, model } = session([[{ type: 'text', text: 'Hm.' }]], {
      skill: () => Promise.resolve({ kind: 'unreadable' }),
    });
    await chat.send('/usr bin is gone?');
    expect(chat.state().skill).toBeNull();
    expect(chat.state().items[0]).toMatchObject({ kind: 'user', text: '/usr bin is gone?' });
    expect(model.requests).toHaveLength(1);
  });

  it('lets a bug in reading a skill fail loudly, not pass as “could not be read”', async () => {
    const bug = new TypeError('skill.problems is undefined');
    const { chat } = session([], { skill: () => Promise.reject(bug) });
    await expect(chat.attachSkill('weekly-review')).rejects.toBe(bug);
    expect(chat.state().skill?.problem ?? null).not.toBe(
      'The skill weekly-review could not be read.',
    );
  });

  it('shows a bug in reading a /name skill as the turn’s error, and is no longer busy', async () => {
    const { chat, model } = session([], {
      skill: () => Promise.reject(new TypeError('skill.problems is undefined')),
    });
    await chat.send('/weekly-review What did I finish?');
    expect(chat.state().busy).toBe(false);
    expect(chat.state().error?.message).toBe('skill.problems is undefined');
    expect(model.requests).toHaveLength(0);
  });
});
