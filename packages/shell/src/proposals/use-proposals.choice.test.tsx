// @vitest-environment jsdom
/**
 * Accept choice (#307, Q12) as the app runs it: the rejects wait for the
 * accept, one Undo takes the whole choice back, and a relation that holds many
 * values is never a pick-one.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createVaultPath, type VaultPath } from '@dfai/domain';
import { recordingActivity, type ProposalPorts } from '@dfai/application';
import { inMemoryProposalVault as vault, windowToasts } from './proposals.test-support.ts';
import { useProposals } from './use-proposals.ts';

const path = (raw: string): VaultPath => createVaultPath(raw);
const noClosing = { beforeClose: async () => () => {} };
const MEETING = 'Inbox/Meetings/2026-10-01 Standup.md';
const LARKSPUR = 'Inbox/Proposals/Mara Quill (Larkspur).md';
const GARDEN = 'Inbox/Proposals/Mara Quill (Garden).md';

const personText = (title: string) => `---
type: proposal
kind: person
source: "[[2026-10-01 Standup#^t0003]]"
confidence: high
payload:
  title: ${title}
  folder: People
  properties: {}
  link_from:
    note: "${MEETING}"
    property: people
---
`;

const notes = (many: boolean) => ({
  [MEETING]: '---\ntype: meeting\npeople: []\n---\n',
  '.atlas/types/meeting.md': `---\nname: meeting\nproperties:\n  people:\n    kind: relation\n    target: person\n    many: ${many}\n---\n`,
  [LARKSPUR]: personText('Mara Quill (Larkspur)'),
  [GARDEN]: personText('Mara Quill (Garden)'),
});

function drive(ports: ProposalPorts) {
  const shown = windowToasts();
  const hook = renderHook(() =>
    useProposals({
      ports,
      clock: { today: () => '2026-10-08' },
      indexKey: 'v1',
      onSettled: vi.fn(),
      activity: recordingActivity(),
      closing: noClosing,
      toasts: shown.toasts,
      onOpen: vi.fn(),
    }),
  );
  return Object.assign(hook, shown);
}

describe('Accept choice', () => {
  it('is undone as a whole: the accept is taken back and the other value is open again', async () => {
    const setup = vault(notes(false));
    const hook = drive(setup.ports);
    await waitFor(() => expect(hook.result.current.count).toBe(2));

    act(() => hook.result.current.section.onAcceptChoice(path(LARKSPUR), [path(GARDEN)]));
    await waitFor(() => expect(hook.said()?.onUndo).toBeDefined());
    await waitFor(() => expect(setup.files.has(`Archive/${GARDEN}`)).toBe(true));
    expect(hook.said()?.message).toMatch(/Rejected 1 other proposal/);

    hook.undo();
    await waitFor(() => expect(hook.result.current.count).toBe(2));
    expect(setup.files.has(GARDEN)).toBe(true);
    expect(setup.files.get(GARDEN)?.text).toContain('state: open');
    expect(setup.files.get(MEETING)?.text).not.toContain('Larkspur');
    expect(hook.said()?.message).toMatch(/open again/);
  });

  it('leaves the other value rejected when the accept could not be undone', async () => {
    const setup = vault(notes(false));
    const hook = drive(setup.ports);
    await waitFor(() => expect(hook.result.current.count).toBe(2));
    act(() => hook.result.current.section.onAcceptChoice(path(LARKSPUR), [path(GARDEN)]));
    await waitFor(() => expect(hook.said()?.onUndo).toBeDefined());
    await waitFor(() => expect(setup.files.has(`Archive/${GARDEN}`)).toBe(true));
    // The meeting changed since: the accept's link is not the note's now.
    setup.files.set(MEETING, {
      text: '---\ntype: meeting\npeople: []\nowner: me\n---\n',
      modified: 9999,
    });

    hook.undo();
    // Refused: said as a warning toast, where the person is.
    await waitFor(() => expect(hook.said()?.tone).toBe('warning'));
    expect(setup.files.has(`Archive/${GARDEN}`)).toBe(true);
  });
});

describe('the listing', () => {
  it('says which shared slots hold many values, so their proposals are not a pick-one', async () => {
    const hook = drive(vault(notes(true)).ports);
    await waitFor(() => expect(hook.result.current.count).toBe(2));
    expect(hook.result.current.section.contents?.manyValued).toEqual([
      { note: MEETING, property: 'people' },
    ]);
  });

  it('reads a note whose type is a list, as the rest of the app does', async () => {
    const listed = {
      ...notes(true),
      [MEETING]: '---\ntype: [meeting]\npeople: []\n---\n',
    };
    const hook = drive(vault(listed).ports);
    await waitFor(() => expect(hook.result.current.count).toBe(2));
    expect(hook.result.current.section.contents?.manyValued).toEqual([
      { note: MEETING, property: 'people' },
    ]);
  });

  it('names none for a relation that holds one', async () => {
    const hook = drive(vault(notes(false)).ports);
    await waitFor(() => expect(hook.result.current.count).toBe(2));
    expect(hook.result.current.section.contents?.manyValued).toEqual([]);
  });
});
