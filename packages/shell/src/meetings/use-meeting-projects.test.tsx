// @vitest-environment jsdom
/**
 * Filing the meetings with no project (#227): the preview is read again as
 * the page comes back and after each run, and the person's ticks survive it —
 * only a row new to them is ticked by what is sure.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createVaultPath, type ProjectBackfillRow, type ProposalConfidence } from '@dfai/domain';
import {
  fakeIndexPort,
  fakeVaultFs,
  previewProjectBackfill,
  recordingActivity,
  type ArchivePorts,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { useMeetingProjects } from './use-meeting-projects.ts';

vi.mock('@dfai/application', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  previewProjectBackfill: vi.fn(),
}));

const preview = vi.mocked(previewProjectBackfill);

const PORTS: ArchivePorts = {
  fs: fakeVaultFs(),
  index: fakeIndexPort(),
  markdown: remarkMarkdown,
  editors: {
    state: () => 'closed',
    flush: async () => undefined,
    follow: () => undefined,
    abandon: () => undefined,
    reload: () => undefined,
  },
} as unknown as ArchivePorts;
const OWNER = { selfName: 'Mara Quill', selfEmails: [] };

const row = (
  name: string,
  confidence: ProposalConfidence,
  project = 'Ledger',
): ProjectBackfillRow => ({
  meeting: createVaultPath(`Meetings/${name}.md`),
  title: name,
  date: '2026-10-01',
  suggestion: {
    project: createVaultPath(`Projects/${project}.md`),
    title: project,
    confidence,
    via: 'series',
    reason: 'Same series.',
  },
});

function render() {
  return renderHook(
    ({ open }: { open: boolean }) =>
      useMeetingProjects({
        ports: PORTS,
        vaultKey: '/vaults/home',
        indexReady: true,
        open,
        owner: OWNER,
        activity: recordingActivity(),
        onChanged: () => undefined,
      }),
    { initialProps: { open: true } },
  );
}

const ticked = (props: ReturnType<typeof useMeetingProjects>) =>
  (props?.rows ?? []).filter((each) => each.chosen).map((each) => each.path);

describe('useMeetingProjects', () => {
  it('keeps the person’s ticks when the preview is read again, and ticks only new sure rows', async () => {
    preview.mockResolvedValueOnce([row('A', 'high'), row('B', 'medium'), row('C', 'high')]);
    const { result, rerender } = render();
    await waitFor(() => expect(result.current?.rows).toHaveLength(3));
    expect(ticked(result.current)).toEqual(['Meetings/A.md', 'Meetings/C.md']);

    act(() => result.current?.onToggle('Meetings/A.md'));
    act(() => result.current?.onToggle('Meetings/B.md'));
    expect(ticked(result.current)).toEqual(['Meetings/B.md', 'Meetings/C.md']);

    // The page goes and comes back: read again, with a new sure row and one whose project changed.
    preview.mockResolvedValueOnce([
      row('A', 'high'),
      row('B', 'medium'),
      row('C', 'medium', 'Payrun'),
      row('D', 'high'),
    ]);
    rerender({ open: false });
    rerender({ open: true });
    await waitFor(() => expect(result.current?.rows).toHaveLength(4));
    expect(ticked(result.current)).toEqual(['Meetings/B.md', 'Meetings/D.md']);
  });
});
