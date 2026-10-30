// @vitest-environment jsdom
/**
 * Opening a vault sets it up for PARA through the real markdown writer, so
 * what is asserted is the YAML each type file ends up holding, byte for byte
 * where the vault's own text is concerned.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { fakeVaultFs, memoryVault, recordingActivity } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { useBuiltInTypes } from './use-built-in-types.ts';

const TASK = [
  '---',
  'name: task',
  'label: Task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [backlog, done]',
  // Given on an earlier opening (#108), so opening this vault adds nothing to it.
  '  focus: date',
  '  # James keeps his estimates in words.',
  '  estimate: text',
  '---',
  '',
  '# Task',
  '',
].join('\n');

/** The vault's files but the record of shipped properties settled, which opening writes. */
const typeFiles = (files: ReadonlyMap<string, string>) =>
  [...files.keys()].filter((path) => path !== '.atlas/migrations/type-properties.md');

function setup(
  files: Record<string, string>,
  { strict = false, held }: { strict?: boolean; held?: Promise<void> } = {},
) {
  const memory = memoryVault(files);
  const fs = fakeVaultFs({
    ...memory.fs,
    readNotes: async (paths) => {
      await held;
      return paths.flatMap((path) => {
        const text = memory.files.get(path);
        return text === undefined ? [] : [{ path, text, modified: 1, size: text.length }];
      });
    },
  });
  const onChanged = vi.fn();
  const activity = recordingActivity();
  const hook = renderHook(
    () =>
      useBuiltInTypes({ fs, markdown: remarkMarkdown, vaultKey: '/vault', activity, onChanged }),
    { reactStrictMode: strict },
  );
  return { files: memory.files, hook, onChanged, activity };
}

/** A Project type from before PARA was its property (#213): no `para`, and an `area` of its own. */
const PROJECT = [
  '---',
  'name: project',
  'label: Project',
  'properties:',
  '  status: select',
  '  area: text',
  '  due: date',
  '  description: text',
  '---',
  '',
  '# Project',
  '',
].join('\n');

/** A Meeting type from before `tasks` and `decisions` (#162), commented as Mara Quill keeps it. */
const OLDER_MEETING = [
  '---',
  'name: meeting',
  'label: Meeting',
  'icon: calendar',
  'properties:',
  '  # Set by the import; Mara reads it on the Inbox page.',
  '  atlas_import_outcome:',
  '    kind: select',
  '    label: How it came in',
  '    options: [imported, error]',
  '  atlas_import_error: text',
  '  atlas_duplicate_of:',
  '    kind: relation',
  '    target: meeting',
  '---',
  '',
  '# Meeting',
  '',
  'Mara’s own words about meetings.',
  '',
].join('\n');

describe('useBuiltInTypes', () => {
  it('says it is still reading the types until they are read, so the Inbox can wait for its offer (#381)', async () => {
    let release = () => {};
    const held = new Promise<void>((done) => (release = done));
    const { hook } = setup({ '.atlas/types/task.md': TASK }, { held });
    expect(hook.result.current?.reading).toBe(true);
    expect(hook.result.current?.lines).toEqual([]);

    await act(async () => release());
    await waitFor(() => expect(hook.result.current?.reading).toBe(false));
    expect(hook.result.current?.lines).toContain(
      'Task gains Project, linking project or area notes.',
    );
  });

  it('is still reading the vault switched to when the last one’s read lands, and shows none of its lines (#423)', async () => {
    const vaultFs = (files: Record<string, string>, held: Promise<void>) => {
      const memory = memoryVault(files);
      return fakeVaultFs({
        ...memory.fs,
        readNotes: async (paths) => {
          await held;
          return paths.flatMap((path) => {
            const text = memory.files.get(path);
            return text === undefined ? [] : [{ path, text, modified: 1, size: text.length }];
          });
        },
      });
    };
    let releaseA = () => {};
    const heldA = new Promise<void>((done) => (releaseA = done));
    const a = vaultFs({ '.atlas/types/task.md': TASK }, heldA);
    const b = vaultFs({ '.atlas/types/task.md': TASK }, new Promise<void>(() => {}));
    const activity = recordingActivity();
    const hook = renderHook(
      ({ fs, vaultKey }: { fs: typeof a; vaultKey: string }) =>
        useBuiltInTypes({ fs, markdown: remarkMarkdown, vaultKey, activity, onChanged: vi.fn() }),
      { initialProps: { fs: a, vaultKey: '/vault-a' } },
    );
    hook.rerender({ fs: b, vaultKey: '/vault-b' });

    await act(async () => releaseA());
    // A's answer is A's: B is still being read, and offers nothing yet.
    expect(hook.result.current?.reading).toBe(true);
    expect(hook.result.current?.lines).toEqual([]);
  });

  it('stops waiting when the types cannot be read, and says why in Activity', async () => {
    const { hook, activity } = setup(
      { '.atlas/types/task.md': TASK },
      { held: Promise.reject(new Error('The disk went away.')) },
    );
    await waitFor(() => expect(hook.result.current).toBeNull());
    expect(activity.reports.map((report) => report.message).join(' ')).toContain('went away');
  });

  it('writes no Area or Resource type into a vault that files by project (#213), and offers PARA instead', async () => {
    const { files, hook, onChanged, activity } = setup({ '.atlas/types/project.md': PROJECT });
    await waitFor(() => expect(hook.result.current?.lines).toContain('Project gains PARA.'));
    expect([...files.keys()].filter((path) => path.startsWith('.atlas/types/'))).toEqual([
      '.atlas/types/project.md',
    ]);
    expect(files.get('.atlas/types/project.md')).toBe(PROJECT);
    expect(onChanged).not.toHaveBeenCalled();
    expect(activity.reports).toEqual([]);
  });

  it('gives the Project type PARA when the offer is accepted, after every line James wrote', async () => {
    const { files, hook } = setup({ '.atlas/types/project.md': PROJECT });
    await waitFor(() => expect(hook.result.current?.lines).toContain('Project gains PARA.'));

    await act(() => hook.result.current?.accept() ?? Promise.resolve());

    expect(files.get('.atlas/types/project.md')).toBe(
      PROJECT.replace(
        '  description: text\n',
        [
          '  description: text',
          '  para:',
          '    kind: select',
          '    label: PARA',
          '    options:',
          '      - project',
          '      - area',
          '      - resource',
          '      - archive',
          '',
        ].join('\n'),
      ),
    );
  });

  it('says nothing in Activity when it only offers', async () => {
    const { hook, activity } = setup({ '.atlas/types/task.md': TASK });
    await waitFor(() => expect(hook.result.current?.lines.length).toBeGreaterThan(0));
    expect(activity.reports).toEqual([]);
  });

  it('offers PARA, the Inbox’s types and Daily to a vault without them, and writes them only when accepted', async () => {
    const { files, hook, onChanged } = setup({ '.atlas/types/task.md': TASK });
    await waitFor(() =>
      expect(hook.result.current?.lines).toEqual([
        'Adds the Project, Proposal, Decision and Daily types.',
        'Task gains Project, linking project or area notes.',
      ]),
    );
    expect(typeFiles(files)).toEqual(['.atlas/types/task.md']);
    expect(onChanged).not.toHaveBeenCalled();

    await act(() => hook.result.current?.accept() ?? Promise.resolve());

    expect(typeFiles(files).sort()).toEqual([
      '.atlas/types/daily.md',
      '.atlas/types/decision.md',
      '.atlas/types/project.md',
      '.atlas/types/proposal.md',
      '.atlas/types/task.md',
    ]);
    // Everything James wrote is still there, as he wrote it; Project is added after it.
    expect(files.get('.atlas/types/task.md')).toBe(
      TASK.replace(
        '  estimate: text\n',
        '  estimate: text\n  project:\n    kind: relation\n    target:\n      - project\n      - area\n',
      ),
    );
    expect(hook.result.current).toBeNull();
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it('accepts against the type as it is now: a property removed since the offer stays removed', async () => {
    const { files, hook } = setup({ '.atlas/types/task.md': TASK });
    await waitFor(() => expect(hook.result.current?.lines.length).toBeGreaterThan(0));
    // While the offer waits, James removes `estimate` in the type editor.
    const edited = TASK.replace('  # James keeps his estimates in words.\n  estimate: text\n', '');
    files.set('.atlas/types/task.md', edited);

    await act(() => hook.result.current?.accept() ?? Promise.resolve());

    const task = files.get('.atlas/types/task.md') ?? '';
    expect(task).not.toContain('estimate');
    expect(task).toBe(
      edited.replace(
        '  focus: date\n',
        '  focus: date\n  project:\n    kind: relation\n    target:\n      - project\n      - area\n',
      ),
    );
  });

  it('puts the offer away for now when dismissed, writing nothing', async () => {
    const { files, hook } = setup({ '.atlas/types/task.md': TASK });
    await waitFor(() => expect(hook.result.current?.lines.length).toBeGreaterThan(0));
    act(() => hook.result.current?.dismiss());
    expect(hook.result.current).toBeNull();
    expect(typeFiles(files)).toEqual(['.atlas/types/task.md']);
    expect(files.get('.atlas/types/task.md')).toBe(TASK);
  });

  it('records a type it could not write when the offer is accepted, and writes the rest', async () => {
    const broken = '---\n: : not yaml\n---\n';
    const { files, hook, activity } = setup({
      '.atlas/types/task.md': TASK,
      '.atlas/types/project.md': broken,
    });
    await waitFor(() => expect(hook.result.current?.lines.length).toBeGreaterThan(0));

    await act(() => hook.result.current?.accept() ?? Promise.resolve());

    expect(activity.reports.map((report) => report.message)).toEqual([
      'The Project type could not be set up for PARA: already there',
    ]);
    expect(files.get('.atlas/types/project.md')).toBe(broken);
    expect(files.has('.atlas/types/proposal.md')).toBe(true);
  });

  it('writes no PARA type on opening, even beside a type file it cannot read (#213)', async () => {
    const broken = '---\n: : not yaml\n---\n';
    const { files, hook, activity } = setup({
      '.atlas/types/project.md': PROJECT,
      '.atlas/types/area.md': broken,
    });
    await waitFor(() => expect(hook.result.current?.lines.length).toBeGreaterThan(0));
    expect(files.get('.atlas/types/area.md')).toBe(broken);
    expect(files.has('.atlas/types/resource.md')).toBe(false);
    expect(activity.reports).toEqual([]);
  });

  it('gives an older Meeting type tasks and decisions on opening, keeping every byte it had', async () => {
    const { files, onChanged } = setup({ '.atlas/types/meeting.md': OLDER_MEETING });
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(files.get('.atlas/types/meeting.md')).toBe(
      OLDER_MEETING.replace(
        '    target: meeting\n',
        [
          '    target: meeting',
          '  tasks:',
          '    kind: relation',
          '    target: task',
          '    many: true',
          '  decisions:',
          '    kind: relation',
          '    target: decision',
          '    many: true',
          '  atlas_summary_digest:',
          '    kind: text',
          '    label: Summary digest',
          '  atlas_summary_of:',
          '    kind: text',
          '    label: Summary of',
          '  atlas_summary_model:',
          '    kind: text',
          '    label: Summary model',
          '',
        ].join('\n'),
      ),
    );
  });

  it('says in Activity which properties a type gained, and writes nothing on the next open', async () => {
    const first = setup({ '.atlas/types/meeting.md': OLDER_MEETING });
    await waitFor(() => expect(first.activity.reports).toHaveLength(1));
    expect(first.activity.reports[0]).toMatchObject({
      level: 'info',
      kind: 'app',
      message:
        'Added Tasks, Decisions, Summary digest, Summary of and Summary model to the Meeting type, which was written before DFAI shipped them.',
      subject: { kind: 'note', path: '.atlas/types/meeting.md' },
    });

    const again = setup(Object.fromEntries(first.files));
    await waitFor(() => expect(again.hook.result.current?.lines.length).toBeGreaterThan(0));
    expect(again.files).toEqual(first.files);
    expect(again.activity.reports).toEqual([]);
    expect(again.onChanged).not.toHaveBeenCalled();
  });

  it('warns in Activity, and writes nothing, when the record of what it added cannot be read', async () => {
    const record = '---\natlas: migration\n---\n\nNot a record any more.\n';
    const { files, activity } = setup({
      '.atlas/types/meeting.md': OLDER_MEETING,
      '.atlas/migrations/type-properties.md': record,
    });
    await waitFor(() => expect(activity.reports).toHaveLength(1));
    expect(activity.reports[0]?.level).toBe('warning');
    expect(activity.reports[0]?.message).toMatch(
      /^DFAI could not add its built-in properties to any type: .*cannot be read/,
    );
    expect(files.get('.atlas/types/meeting.md')).toBe(OLDER_MEETING);
  });

  it('reports the properties added once, and no failure, when StrictMode runs the effect twice', async () => {
    const { files, activity } = setup(
      { '.atlas/types/meeting.md': OLDER_MEETING },
      { strict: true },
    );
    await waitFor(() => expect(activity.reports).toHaveLength(1));
    expect(activity.reports[0]).toMatchObject({
      level: 'info',
      message:
        'Added Tasks, Decisions, Summary digest, Summary of and Summary model to the Meeting type, which was written before DFAI shipped them.',
    });
    expect(files.get('.atlas/types/meeting.md')).toContain('  decisions:\n');
  });

  it('warns in Activity, and writes nothing, on a Meeting type whose properties are a list', async () => {
    const listed = '---\nname: meeting\nproperties:\n  - title\n  - attendees\n---\n';
    const { files, activity } = setup({ '.atlas/types/meeting.md': listed });
    await waitFor(() => expect(activity.reports).toHaveLength(1));
    expect(activity.reports[0]).toMatchObject({
      level: 'warning',
      message: expect.stringMatching(
        /^DFAI did not add its built-in properties to the Meeting type: its `properties` is not a map/,
      ),
      subject: { kind: 'note', path: '.atlas/types/meeting.md' },
    });
    expect(files.get('.atlas/types/meeting.md')).toBe(listed);
    expect(files.has('.atlas/migrations/type-properties.md')).toBe(false);
  });
});
