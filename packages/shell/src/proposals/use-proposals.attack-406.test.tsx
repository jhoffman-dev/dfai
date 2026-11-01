// @vitest-environment jsdom
/**
 * Attack on PR #406 (#307): "Accept choice" on a conflict group, as the section
 * fires it today — `onAccept(picked)`, then `onRejectMany(rest)` — driven
 * through the app's hook over a vault in memory. A partial failure must leave
 * no proposal lost or applied twice, and the accept must stay undoable.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createVaultPath, proposalEntries, type VaultPath } from '@dfai/domain';
import { recordingActivity, type ProposalPorts } from '@dfai/application';
import { inMemoryProposalVault as vault, windowToasts } from './proposals.test-support.ts';
import { useProposals } from './use-proposals.ts';

const path = (raw: string): VaultPath => createVaultPath(raw);
const noClosing = { beforeClose: async () => () => {} };

const MEETING = 'Inbox/Meetings/2026-10-01 Standup.md';
const LARKSPUR = 'Inbox/Proposals/Mara Quill (Larkspur).md';
const GARDEN = 'Inbox/Proposals/Mara Quill (Garden).md';

/** Two people proposed for one mention in one block: a conflict group of two values. */
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

const NOTES = {
  [MEETING]: '---\ntype: meeting\npeople: []\n---\n',
  '.atlas/types/meeting.md':
    '---\nname: meeting\nproperties:\n  people:\n    kind: relation\n    target: person\n    many: false\n---\n',
  [LARKSPUR]: personText('Mara Quill (Larkspur)'),
  [GARDEN]: personText('Mara Quill (Garden)'),
};

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

/** What ConflictGroupRow's Accept choice does with the picked path and the rest. */
const acceptChoice = (
  hook: ReturnType<typeof drive>,
  picked: VaultPath,
  rest: readonly VaultPath[],
) =>
  act(() => {
    hook.result.current.section.onAcceptChoice(picked, rest);
  });

const openPaths = (hook: ReturnType<typeof drive>) =>
  hook.result.current.section.contents?.open.map((each) => each.path) ?? [];

describe('Accept choice — as the section fires it (attack #406)', () => {
  it('starts from one conflict group of the two people', async () => {
    const setup = vault(NOTES);
    const hook = drive(setup.ports);
    await waitFor(() => expect(hook.result.current.count).toBe(2));
    const entries = proposalEntries(hook.result.current.section.contents?.open ?? []);
    expect(entries).toHaveLength(1);
    expect('choice' in entries[0]!).toBe(true);
  });

  it('offers Undo for the accept it made, once the rejects of the rest have landed', async () => {
    const setup = vault(NOTES);
    const hook = drive(setup.ports);
    await waitFor(() => expect(hook.result.current.count).toBe(2));

    acceptChoice(hook, path(LARKSPUR), [path(GARDEN)]);
    await waitFor(() => expect(setup.files.has(`Archive/${GARDEN}`)).toBe(true));
    await waitFor(() => expect(setup.files.has(`Archive/${LARKSPUR}`)).toBe(true));
    expect(setup.files.has('People/Mara Quill (Larkspur).md')).toBe(true);

    // The accept made a person and linked them: it must be one Undo away.
    await waitFor(() => expect(hook.said()?.onUndo).toBeTypeOf('function'));
  });

  it('rejects none of the other choices when the accept of the one picked is refused', async () => {
    // The picked person's note cannot be made: the accept is refused.
    const setup = vault(NOTES);
    const ports: ProposalPorts = {
      ...setup.ports,
      fs: {
        ...setup.ports.fs,
        createNote: async () => {
          throw new Error('the disk is full');
        },
      },
    };
    const hook = drive(ports);
    await waitFor(() => expect(hook.result.current.count).toBe(2));

    acceptChoice(hook, path(LARKSPUR), [path(GARDEN)]);
    await waitFor(() =>
      expect(hook.result.current.section.problems.has(path(LARKSPUR))).toBe(true),
    );

    // Nothing was accepted, so the question must still stand: Garden open, not rejected.
    expect(setup.files.get(`Archive/${GARDEN}`)?.text ?? '').not.toContain('state: rejected');
    expect(openPaths(hook).sort()).toEqual([GARDEN, LARKSPUR].sort());
  });

  it('never lets Accept-all apply a second value for the slot when the reject of the rest failed', async () => {
    const setup = vault(NOTES);
    const ports: ProposalPorts = {
      ...setup.ports,
      fs: {
        ...setup.ports.fs,
        // Garden's answer cannot be written: its reject fails and it comes back.
        writeTextFile: async (args) => {
          if (args.path === GARDEN) throw new Error('the disk is full');
          return setup.ports.fs.writeTextFile(args);
        },
      },
    };
    const hook = drive(ports);
    await waitFor(() => expect(hook.result.current.count).toBe(2));

    acceptChoice(hook, path(LARKSPUR), [path(GARDEN)]);
    await waitFor(() => expect(setup.files.has(`Archive/${LARKSPUR}`)).toBe(true));
    await waitFor(() => expect(hook.result.current.section.problems.has(path(GARDEN))).toBe(true));
    const open = hook.result.current.section.contents?.open ?? [];
    expect(open.map((each) => each.path)).toContain(GARDEN);

    // Garden is open on its own now, so "Accept all" would offer it; the apply refuses it, saying why.
    act(() => hook.result.current.section.onAcceptMany([path(GARDEN)]));
    await waitFor(() =>
      expect(hook.result.current.section.problems.get(path(GARDEN))).toMatch(/already links/),
    );
    expect(setup.files.get(MEETING)?.text).toContain('Mara Quill (Larkspur)');
    expect(setup.files.get(MEETING)?.text).not.toContain('Garden');
    expect(setup.files.has('People/Mara Quill (Garden).md')).toBe(false);
  });
});
