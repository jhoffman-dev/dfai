import { describe, expect, it } from 'vitest';
import { proposalFileFor } from '../proposals/new-proposal.ts';
import { isNoteProposal, readProposal } from '../proposals/proposal.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import { answeredMeetingOf } from './answered-note.ts';
import { claudeNewProposal } from './claude-proposal-id.ts';
import {
  checkDraft,
  isRecord,
  refused,
  registerProposalSchema,
  type AnswerContext,
  type ProposalDraft,
  type ProposalSchema,
} from './proposal-schema.ts';
import { proposalSchemaNamed } from './proposal-schemas.ts';

/**
 * The stack of #100 on #99: a proposal's payload can now carry `link_from`
 * and a meeting's identity, which Accept writes into a note that is already
 * there. No answer may write either. The one way a Claude step's proposal
 * joins a meeting is the schema's: a relation it lists, of the meeting the
 * draft cites, named by the identity the run read from that meeting's file.
 */

const STANDUP = createVaultPath('Meetings/2026-10-06 Standup.md');
const NOTES_NOTE = createVaultPath('Notes/Payroll notes.md');
const IDENTITY = { provider: 'gemini', externalId: 'gemini-7f3a9c21' };

const CONTEXT: AnswerContext = {
  notes: [
    {
      path: STANDUP,
      text: '**Mara Quill** [00:00:05] Send me the payroll file. ^t0003\n',
      meeting: { identity: IDENTITY },
    },
    { path: NOTES_NOTE, text: 'Payroll runs on Friday. ^p1\n' },
  ],
};

const draft = (fields: Partial<ProposalDraft> = {}): ProposalDraft => ({
  kind: 'task',
  payload: { title: 'Send Mara the payroll file' },
  source: '[[2026-10-06 Standup#^t0003]]',
  confidence: 'high',
  why: 'Mara asked for it.',
  ...fields,
});

/** A schema as P29-05's will be: each action item is a task that joins its meeting's `tasks`. */
const ACTIONS: ProposalSchema<{ title: string; source: string }> = {
  name: 'meeting-actions',
  key: 'items',
  itemShape: '{ "title": what to do; "source_block": the turn it came from }.',
  itemKeys: ['title', 'source_block'],
  meetingRelations: ['tasks'],
  readItem: (value) =>
    isRecord(value) &&
    typeof value['title'] === 'string' &&
    typeof value['source_block'] === 'string'
      ? { ok: true, value: { title: value['title'], source: value['source_block'] } }
      : refused('It needs a title and a source_block.'),
  draftsOf: (item) => [
    draft({ payload: { title: item.title }, source: item.source, joinsMeeting: 'tasks' }),
  ],
};
const actions = registerProposalSchema(ACTIONS);
const answer = (...items: unknown[]) => JSON.stringify({ items });

describe('what no answer may write, now a payload can link', () => {
  it.each([
    ['link_from', { note: 'People/Mara Quill.md', property: 'tasks' }],
    ['linkFrom', { note: 'People/Mara Quill.md', property: 'tasks' }],
    ['meeting', { provider: 'gemini', external_id: 'gemini-7f3a9c21' }],
    ['digest', 'abc'],
    ['note', 'People/Mara Quill.md'],
    ['link', '[[Mara Quill]]'],
  ])('refuses a draft whose payload has %s', (key, value) => {
    const read = checkDraft(draft({ payload: { title: 'A', [key]: value } }), CONTEXT, ['tasks']);
    expect(read).toMatchObject({ ok: false, problem: expect.stringContaining(`“${key}”`) });
  });

  it('refuses a link proposal, though a link payload may now go without a digest', () => {
    const link = draft({
      kind: 'link' as never,
      payload: { note: 'People/Mara Quill.md', property: 'tasks', link: '[[Send the file]]' },
    });
    expect(checkDraft(link, CONTEXT, ['tasks'])).toEqual({
      ok: false,
      problem: 'A Claude step proposes new notes only.',
    });
  });

  it('refuses a general item that names a note to link from, as a key or as a property', () => {
    const general = proposalSchemaNamed('proposals')!;
    const item = {
      kind: 'task',
      title: 'Send the file',
      source: '[[2026-10-06 Standup#^t0003]]',
      confidence: 'high',
    };
    const from = { note: 'People/Mara Quill.md', property: 'tasks' };
    const asked = (more: Record<string, unknown>) =>
      general.read(JSON.stringify({ proposals: [{ ...item, ...more }] }), CONTEXT);
    expect(asked({}).ok).toBe(true);
    expect(asked({ link_from: from }).ok).toBe(false);
    expect(asked({ meeting: { provider: 'gemini', external_id: 'x' } }).ok).toBe(false);
    expect(asked({ properties: { link_from: from } }).ok).toBe(false);
  });

  it('links nothing for a general proposal, even about a meeting', () => {
    const read = checkDraft(draft(), CONTEXT);
    expect(read.ok && read.value.payload.linkFrom).toBeNull();
  });
});

describe('a schema whose proposals join the meeting they cite', () => {
  it('links the note it makes from the cited meeting, named by the identity the run read', () => {
    const read = actions.read(
      answer({
        title: 'Send Mara the payroll file',
        source_block: '[[2026-10-06 Standup#^t0003]]',
      }),
      CONTEXT,
    );
    expect(read.ok && read.value[0]!.payload.linkFrom).toEqual({
      note: STANDUP,
      property: 'tasks',
      meeting: IDENTITY,
    });
  });

  it('writes the link as Accept reads it: link_from, with the meeting’s provider and id', () => {
    const read = actions.read(
      answer({
        title: 'Send Mara the payroll file',
        source_block: '[[2026-10-06 Standup#^t0003]]',
      }),
      CONTEXT,
    );
    if (!read.ok) throw new Error(read.problem);
    const file = proposalFileFor(
      claudeNewProposal({ rule: 'Actions', madeBy: 'Actions · now', proposal: read.value[0]! }),
    );
    expect(file.properties['payload']).toEqual({
      title: 'Send Mara the payroll file',
      link_from: {
        note: STANDUP,
        property: 'tasks',
        meeting: { provider: 'gemini', external_id: 'gemini-7f3a9c21' },
      },
    });
    const back = readProposal({ path: file.path, properties: file.properties });
    expect(back.ok && isNoteProposal(back.proposal) && back.proposal.payload.linkFrom).toEqual({
      note: STANDUP,
      property: 'tasks',
      meeting: IDENTITY,
    });
  });

  it('gives the answer no way to name the note: an item with a target of its own is refused', () => {
    const item = { title: 'Send it', source_block: '[[2026-10-06 Standup#^t0003]]' };
    for (const key of ['link_from', 'meeting', 'note', 'joinsMeeting']) {
      const read = actions.read(answer({ ...item, [key]: 'People/Mara Quill.md' }), CONTEXT);
      expect(read).toMatchObject({ ok: false, problem: expect.stringContaining(key) });
    }
  });

  it('refuses a draft citing a note that is not a meeting the import let in', () => {
    const notMeeting = actions.read(
      answer({ title: 'Pay on Friday', source_block: '[[Payroll notes#^p1]]' }),
      CONTEXT,
    );
    expect(notMeeting).toEqual({
      ok: false,
      problem: 'Item 1: It links back to the meeting it cites, and the note it cites is not one.',
    });
    const unstamped: AnswerContext = {
      notes: [{ ...CONTEXT.notes[0]!, meeting: { identity: null } }],
    };
    const read = actions.read(
      answer({ title: 'Send it', source_block: '[[2026-10-06 Standup#^t0003]]' }),
      unstamped,
    );
    expect(read.ok).toBe(false);
  });

  it('refuses a relation the schema does not list, and any relation from a schema that lists none', () => {
    const other = checkDraft(draft({ joinsMeeting: 'people' }), CONTEXT, ['tasks']);
    expect(other).toEqual({
      ok: false,
      problem: 'It would join “people” of a meeting, which this output does not link through.',
    });
    expect(checkDraft(draft({ joinsMeeting: 'tasks' }), CONTEXT).ok).toBe(false);
    expect(checkDraft(draft({ joinsMeeting: 'tasks' }), CONTEXT, ['tasks']).ok).toBe(true);
  });

  it('refuses to register a schema that would link through a key DFAI keeps', () => {
    for (const relation of ['atlas_import_outcome', 'type', '__proto__', 'a:b']) {
      expect(() => registerProposalSchema({ ...ACTIONS, meetingRelations: [relation] })).toThrow(
        /meeting-actions output cannot link/,
      );
    }
  });
});

describe('what the run knows of a note as a meeting', () => {
  const header = {
    type: 'meeting',
    provider: 'gemini',
    external_id: ' gemini-7f3a9c21 ',
    atlas_import_outcome: 'imported',
  };

  it('names a meeting the import let in by its provider and id', () => {
    expect(answeredMeetingOf(header)).toEqual({ identity: IDENTITY, attendees: [] });
  });

  it('vouches for no identity before the stamp, on a copy or a refusal, or without both keys', () => {
    const unstamped = Object.fromEntries(
      Object.entries(header).filter(([key]) => key !== 'atlas_import_outcome'),
    );
    expect(answeredMeetingOf(unstamped)).toMatchObject({ identity: null });
    expect(answeredMeetingOf({ ...header, atlas_import_outcome: 'duplicate' })).toMatchObject({
      identity: null,
    });
    expect(answeredMeetingOf({ ...header, atlas_import_outcome: 'error' })).toMatchObject({
      identity: null,
    });
    expect(answeredMeetingOf({ ...header, external_id: '  ' })).toMatchObject({ identity: null });
    expect(answeredMeetingOf({ ...header, provider: 7 })).toMatchObject({ identity: null });
  });

  it('says a note of another type is no meeting', () => {
    expect(answeredMeetingOf({ ...header, type: 'task' })).toBeUndefined();
    expect(answeredMeetingOf({})).toBeUndefined();
  });

  it('reads a type written as a list or in another case as linking does, and lists who was there', () => {
    const attendees = [{ name: 'Mara Quill', email: 'mara.quill@example.com' }, { name: ' ' }];
    for (const type of ['Meeting', ['note', ' meeting ']]) {
      expect(answeredMeetingOf({ ...header, type, attendees })).toEqual({
        identity: IDENTITY,
        attendees: [{ name: 'Mara Quill', email: 'mara.quill@example.com', group: false }],
      });
    }
    expect(answeredMeetingOf({ ...header, type: 'meetings' })).toBeUndefined();
  });
});
