import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  applyProposal,
  createVaultPath,
  joinFrontmatter,
  parseObjectType,
  payloadRecord,
  readProposal,
  readProposalPayload,
  splitFrontmatter,
  type ProposalNote,
} from '@dfai/domain';
import { remarkMarkdown } from './markdown-port.ts';

/**
 * A proposal is a note (ADR-0028), and its `payload` is a nested YAML record
 * no property kind describes. These run the real YAML reader and writer over
 * one: the payload must read back as written, survive Accept and Reject
 * stamping `state` byte for byte (ADR-0003), and an edited payload must be
 * written so that it reads back as edited.
 */

const markdown = remarkMarkdown;
const path = createVaultPath('Inbox/Proposals/Send the payroll file.md');

const PROPOSAL = `---
type: proposal
kind: task
state: open
confidence: high
source: "[[2026-10-01 Standup#^t0003]]"
made_by: after-meeting · run 2026-10-01T10:02
payload:
  title: Send Mara the payroll file   # as Mara said it
  properties:
    status: next
    meeting: "[[2026-10-01 Standup]]"
    people: ['[[Mara Quill]]', "[[Tobias Fenn]]"]
  body: |
    Mara asked for the Larkspur Payroll file
    by Friday.
---
Proposed from the standup.
`;

function read(text: string): ProposalNote {
  const { frontmatter } = splitFrontmatter(text);
  const reading = readProposal({ path, properties: markdown.frontmatterProperties(frontmatter) });
  if (!reading.ok) throw new Error(reading.problem);
  return reading.proposal;
}

function stamped(text: string, changes: Record<string, unknown>): string {
  const { frontmatter, body } = splitFrontmatter(text);
  return markdown.updateFrontmatter(frontmatter, changes) + body;
}

/** The payload block as written: from `payload:` to the closing fence. */
const payloadBlock = (text: string) => /\npayload:\n[\s\S]*?(?=\n---\n)/.exec(text)?.[0];

describe('a proposal note read by the real YAML reader', () => {
  it('reads its payload, block scalar and quoted links included', () => {
    expect(read(PROPOSAL)).toMatchObject({
      kind: 'task',
      source: '[[2026-10-01 Standup#^t0003]]',
      payload: {
        title: 'Send Mara the payroll file',
        body: 'Mara asked for the Larkspur Payroll file\nby Friday.\n',
        properties: {
          status: 'next',
          meeting: '[[2026-10-01 Standup]]',
          people: ['[[Mara Quill]]', '[[Tobias Fenn]]'],
        },
      },
    });
  });

  it.each(['accepted', 'rejected'])(
    'keeps the payload byte for byte when %s is stamped',
    (state) => {
      const after = stamped(PROPOSAL, { state });
      expect(after).toBe(PROPOSAL.replace('state: open', `state: ${state}`));
      expect(payloadBlock(after)).toBe(payloadBlock(PROPOSAL));
      expect(read(after).payload).toEqual(read(PROPOSAL).payload);
    },
  );

  it('writes an edited payload so that it reads back as edited, keeping the rest', () => {
    const proposal = read(PROPOSAL);
    const edit = readProposalPayload('task', {
      title: 'Send Mara the Q4 file',
      properties: { status: 'doing', people: ['[[Mara Quill]]'] },
      body: 'By Thursday: "early".\n',
    });
    if (!edit.ok) throw new Error(edit.problem);
    const after = stamped(PROPOSAL, { state: 'accepted', payload: payloadRecord(edit.payload) });

    expect(read(after).payload).toEqual(edit.payload);
    expect(after).toContain('made_by: after-meeting · run 2026-10-01T10:02\n');
    expect(after.endsWith('---\nProposed from the standup.\n')).toBe(true);
    expect(proposal.payload).not.toEqual(edit.payload);
  });

  it('makes a task whose source and meeting links read back as links', () => {
    const applied = applyProposal(read(PROPOSAL), { notePaths: [], target: null });
    if (!applied.ok) throw new Error(applied.problem);
    const [write] = applied.writes;
    if (write?.kind !== 'create') throw new Error('no note');
    const task = joinFrontmatter(markdown.updateFrontmatter(null, write.properties), write.body);

    expect(markdown.frontmatterProperties(splitFrontmatter(task).frontmatter)).toEqual({
      type: 'task',
      status: 'next',
      meeting: '[[2026-10-01 Standup]]',
      people: ['[[Mara Quill]]', '[[Tobias Fenn]]'],
      source: '[[2026-10-01 Standup#^t0003]]',
    });
    expect(splitFrontmatter(task).body).toBe(
      'Mara asked for the Larkspur Payroll file\nby Friday.\n',
    );
  });
});

describe('the types this vault ships for proposals', () => {
  const root = new URL('../../../../', import.meta.url);
  const typeOf = (name: string) => {
    const file = readFileSync(new URL(`vault/.atlas/types/${name}.md`, root), 'utf8');
    return parseObjectType(markdown.frontmatterProperties(splitFrontmatter(file).frontmatter));
  };
  const kinds = (name: string) =>
    Object.fromEntries(typeOf(name).properties.map((property) => [property.key, property.kind]));

  it('Proposal declares its kind, state and confidence as choices, and its source and maker', () => {
    expect(kinds('proposal')).toEqual({
      kind: 'select',
      state: 'select',
      confidence: 'select',
      source: 'text',
      made_by: 'text',
      answered_via: 'select',
    });
    expect(typeOf('proposal').properties[0]?.options).toEqual([
      'task',
      'decision',
      'follow-up',
      'person',
      'link',
      'term',
      'project',
      'dashboard',
      'view',
    ]);
  });

  it('Decision has a title, date, meeting, project, people and source', () => {
    expect(kinds('decision')).toEqual({
      title: 'text',
      date: 'date',
      meeting: 'relation',
      project: 'relation',
      people: 'relation',
      source: 'text',
    });
  });

  it('Task links the meeting it came from', () => {
    expect(typeOf('task').properties.find((property) => property.key === 'meeting')).toMatchObject({
      kind: 'relation',
      target: 'meeting',
      many: false,
    });
  });
});
