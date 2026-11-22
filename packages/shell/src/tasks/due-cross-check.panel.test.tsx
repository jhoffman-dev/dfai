// @vitest-environment jsdom
/**
 * PR #930: the properties panel in the due cross-check. For every due value,
 * its row reads what the due module reads (`dueOf`), its time field shows
 * that time, and what the panel writes keeps the promise it showed: a time
 * set is that time, a time cleared is the day, a new day keeps the time.
 * Then what the review asked of undo and of the reader: a view's move is
 * taken back to the exact text, and the real reader hands the index text,
 * never a `Date`, for an unquoted timestamp.
 */
import { describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import {
  createVaultPath,
  dueOf,
  movedDue,
  parseObjectType,
  splitFrontmatter,
  type VaultPath,
} from '@dfai/domain';
import { DUE_FORM_DAY, EVERY_DUE_VALUE } from '@dfai/domain/testing';
import {
  fakeIndexPort,
  fakeMarkdown,
  fakeVaultFs,
  memoryVault,
  setNoteProperties,
  undoLastWrite,
  writeUndoably,
  type OpenNote,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { PropertiesPanel } from '@dfai/ui';
import { useNoteProperties } from '../types/use-note-properties.ts';

const TASK = parseObjectType({ name: 'task', properties: { due: 'date' } });
const links = { fs: fakeVaultFs(), markdown: fakeMarkdown(), notePaths: [] as VaultPath[] };
const index = fakeIndexPort();

function dueRow(value: unknown) {
  const open = {
    path: createVaultPath('Tasks/Probe.md'),
    properties: { type: 'task', due: value },
  } as unknown as OpenNote;
  const { result, unmount } = renderHook(() =>
    useNoteProperties({ note: open, types: [TASK], index, links }),
  );
  const row = result.current.rows.find((each) => each.def.key === 'due');
  unmount();
  if (row === undefined) throw new Error('no due row');
  return row;
}

describe.each(EVERY_DUE_VALUE)('the panel, a due written $form', ({ value }) => {
  const want = dueOf(value);

  it('reads it as the due module does, and offers a time field only for a due', () => {
    const row = dueRow(value);
    expect(row.due ?? null).toEqual(want);
    expect(row.editor === 'dueTime').toBe(want !== null);
  });

  it('writes what its time field and its date promise', () => {
    if (want === null) return;
    const onChange = vi.fn();
    render(
      <PropertiesPanel
        typeName="task"
        rows={[dueRow(value)]}
        relationChoices={{}}
        onChange={onChange}
      />,
    );
    // A list holding lists is drawn whole, edited in the note's properties, as on main:
    // no date or time field offered, so nothing is written from here.
    if (document.querySelector('.props__structured') !== null) {
      expect(screen.queryByLabelText(/^due time$/i)).toBeNull();
      expect(screen.queryByLabelText(/^due$/i)).toBeNull();
      cleanup();
      return;
    }
    const time = screen.getByLabelText(/^due time$/i) as HTMLInputElement;
    expect(time.value).toBe(want.time ?? '');

    fireEvent.change(time, { target: { value: '09:05' } });
    fireEvent.blur(time);
    expect(dueOf(onChange.mock.lastCall?.[1])).toMatchObject({ day: want.day, time: '09:05' });

    const clear = screen.queryByRole('button', { name: /^clear time of due$/i });
    expect(clear !== null).toBe(want.time !== null);
    if (clear !== null) {
      fireEvent.click(clear);
      expect(onChange).toHaveBeenLastCalledWith('due', want.day);
    }

    const date = screen.getByLabelText(/^due$/i);
    fireEvent.change(date, { target: { value: '2026-12-05' } });
    fireEvent.blur(date);
    expect(dueOf(onChange.mock.lastCall?.[1])).toMatchObject({
      day: '2026-12-05',
      time: want.time,
    });
    cleanup();
  });
});

describe('undo of a task calendar’s move (#320)', () => {
  it.each(['2026-12-04T15:30', '2026-12-04T24:00', '2026-12-04T15:30:59', '2026-12-04T15:30Z'])(
    'puts %s back byte for byte',
    async (written) => {
      const path = createVaultPath('Tasks/Probe.md');
      const before = `---\ntype: task\ndue: ${written}\n---\n\nBody.\n`;
      const memory = memoryVault({ [path]: before });
      const fs = fakeVaultFs(memory.fs);
      const move = movedDue({ start: written, end: null, days: 1, minutes: 0 });
      if (move === null) throw new Error('not moved');
      const { record } = await writeUndoably({
        fs,
        path,
        write: (recording) =>
          setNoteProperties({
            fs: recording,
            markdown: remarkMarkdown,
            path,
            values: { due: move.start },
            today: DUE_FORM_DAY,
          }),
      });
      expect(memory.files.get(path)).not.toBe(before);
      if (record === null) throw new Error('no record');
      await undoLastWrite({ fs, panes: { state: () => 'closed', reload: () => {} }, record });
      expect(memory.files.get(path)).toBe(before);
    },
  );
});

describe('the markdown reader and a timestamp', () => {
  it.each(['2026-12-04', '2026-12-04T15:30', '2026-12-04 15:30', '2026-12-04T15:30:00Z'])(
    'hands the index %s unquoted as text, never a Date',
    (written) => {
      const { frontmatter } = splitFrontmatter(`---\ndue: ${written}\n---\n`);
      const due = remarkMarkdown.frontmatterProperties(frontmatter)['due'];
      expect(due).toBe(written);
    },
  );
});
