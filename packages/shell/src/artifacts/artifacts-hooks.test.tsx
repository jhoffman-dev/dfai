// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createVaultPath, type VaultEntry } from '@dfai/domain';
import {
  createThumbnailQueue,
  fakeIndexPort,
  fakeVaultFs,
  openNote,
  type OpenNote,
  type ThumbnailJob,
  type VaultFsPort,
  recordingActivity,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { useArtifactCopy } from './use-artifact-copy.ts';
import { useNewArtifact } from './use-new-artifact.ts';

const CLOCK = {
  today: () => '2026-09-25',
  now: () => 1_000,
  localNow: () => '2026-09-25T09:00:00',
};
const NOTE_PATH = 'artifacts/Q3.md';
const LINK = 'https://claude.ai/artifact/q3';

/** A vault held as text by path, whose folders are the ones its files sit in or were made. */
function memoryVault(files: Record<string, string>) {
  const text = new Map(Object.entries(files));
  const bytes = new Map<string, Uint8Array>();
  const folders = new Set<string>();
  const paths = () => [...text.keys(), ...bytes.keys(), ...folders];
  const fs: VaultFsPort = fakeVaultFs({
    listDirectory: async (folder) => {
      const prefix = folder === '' ? '' : `${folder}/`;
      const children = new Map<string, VaultEntry>();
      for (const path of paths().filter((candidate) => candidate.startsWith(prefix))) {
        const [name = '', ...rest] = path.slice(prefix.length).split('/');
        const child = createVaultPath(prefix + name);
        const kind = rest.length > 0 || folders.has(child) ? 'directory' : 'file';
        children.set(name, { kind, name, path: child } as VaultEntry);
      }
      return [...children.values()];
    },
    readTextFile: async (path) => {
      const found = text.get(path) ?? new TextDecoder().decode(bytes.get(path));
      return { text: found, modified: 1 };
    },
    readBinaryFile: async (path) => (bytes.get(path) ?? new Uint8Array()).slice().buffer,
    createFolder: async ({ path }) => void folders.add(path),
    createNote: async ({ path, contents }) => {
      text.set(path, contents);
      return 0;
    },
    writeBinaryFile: async ({ path, bytes: written }) => {
      bytes.set(path, written);
      return written.byteLength;
    },
  });
  return { fs, text, bytes, folders };
}

const open = (fs: VaultFsPort): Promise<OpenNote> =>
  openNote({ fs, markdown: remarkMarkdown, path: createVaultPath(NOTE_PATH) });

/** A real queue over a generator the test settles by hand, and the jobs it was given. */
function handQueue() {
  const jobs: ThumbnailJob[] = [];
  const finish: (() => void)[] = [];
  const thumbnails = createThumbnailQueue({
    generate: (job) =>
      new Promise((resolve) => {
        jobs.push(job);
        finish.push(() =>
          resolve({
            kind: 'made',
            path: createVaultPath('artifacts/q3/atlas-thumbnail.png'),
            cover: 'q3/atlas-thumbnail.png',
          }),
        );
      }),
  });
  return { thumbnails, jobs, finish };
}

function copyHook(fs: VaultFsPort, note: OpenNote | null) {
  const links = { open: vi.fn(async () => {}) };
  const setProperties = vi.fn<(changes: unknown) => Promise<void>>(async () => {});
  const onChanged = vi.fn();
  const { thumbnails, jobs, finish } = handQueue();
  const activity = recordingActivity();
  const hook = renderHook(() =>
    useArtifactCopy({
      note,
      fs,
      clock: CLOCK,
      links,
      thumbnails,
      setProperties,
      activity,
      onChanged,
    }),
  );
  return { hook, links, setProperties, onChanged, jobs, finish, activity };
}

describe('useArtifactCopy', () => {
  it('is nothing for a note that is not an artifact', async () => {
    const { fs } = memoryVault({ [NOTE_PATH]: '---\ntype: task\n---\n' });
    const { hook } = copyHook(fs, await open(fs));
    expect(hook.result.current).toBeNull();
  });

  it('reads the saved copy into one page for the frame, and opens the link', async () => {
    const { fs } = memoryVault({
      [NOTE_PATH]: `---\ntype: artifact\nurl: ${LINK}\nsaved: artifacts/q3\n---\n`,
      'artifacts/q3/index.html': '<html><head></head><h1>Numbers</h1></html>',
    });
    const { hook, links } = copyHook(fs, await open(fs));

    await waitFor(() => expect(hook.result.current?.copy.kind).toBe('ready'));
    const copy = hook.result.current?.copy;
    expect(copy?.kind === 'ready' && copy.page).toContain('<h1>Numbers</h1>');
    expect(copy?.kind === 'ready' && copy.page).toContain('Content-Security-Policy');

    act(() => hook.result.current?.openLink());
    expect(links.open).toHaveBeenCalledWith(LINK);
  });

  it('turns a page dropped on a link-only note into its copy, told to the note through its pane', async () => {
    const { fs, bytes } = memoryVault({ [NOTE_PATH]: '---\ntype: artifact\n---\n' });
    const { hook, setProperties, onChanged, jobs } = copyHook(fs, await open(fs));
    await waitFor(() => expect(hook.result.current?.copy.kind).toBe('none'));
    expect(hook.result.current?.url).toBeNull();

    const page = new File(['<p>hi</p>'], 'q3.html', { type: 'text/html' });
    act(() => hook.result.current?.addCopy([page]));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(new TextDecoder().decode(bytes.get('artifacts/q3/index.html'))).toBe('<p>hi</p>');
    expect(setProperties).toHaveBeenCalledWith({ saved: 'artifacts/q3', saved_at: '2026-09-25' });
    // …and, once the note knows where its copy is, the copy is pictured.
    expect(jobs).toEqual([{ path: NOTE_PATH, asked: false }]);
    expect(hook.result.current?.adding).toBe(false);
  });

  it('shows why dropped files could not be a copy', async () => {
    const { fs } = memoryVault({ [NOTE_PATH]: '---\ntype: artifact\n---\n' });
    const { hook, setProperties } = copyHook(fs, await open(fs));
    act(() => hook.result.current?.addCopy([new File(['x'], 'a.css')]));
    await waitFor(() => expect(hook.result.current?.error).toMatch(/no page to open/));
    expect(setProperties).not.toHaveBeenCalled();
  });
});

describe('useArtifactCopy and the Activity log', () => {
  const page = () => new File(['<p>hi</p>'], 'q3.html', { type: 'text/html' });

  it('records a copy that could not be written once, naming the artifact', async () => {
    const vault = memoryVault({ [NOTE_PATH]: '---\ntype: artifact\n---\n' });
    vault.fs.writeBinaryFile = async () => {
      throw new Error('The disk is full.');
    };
    const { hook, activity } = copyHook(vault.fs, await open(vault.fs));
    act(() => hook.result.current?.addCopy([page()]));
    await waitFor(() => expect(hook.result.current?.error).toBe('The disk is full.'));
    expect(activity.reports).toEqual([
      {
        level: 'error',
        kind: 'save',
        message: 'Could not save the artifact — Q3. The disk is full.',
        subject: { kind: 'note', path: NOTE_PATH },
      },
    ]);
  });

  it('records nothing for a copy saved, or files refused as no copy', async () => {
    const { fs } = memoryVault({ [NOTE_PATH]: '---\ntype: artifact\n---\n' });
    const { hook, onChanged, activity } = copyHook(fs, await open(fs));
    act(() => hook.result.current?.addCopy([new File(['x'], 'a.css')]));
    await waitFor(() => expect(hook.result.current?.error).toMatch(/no page to open/));
    act(() => hook.result.current?.addCopy([page()]));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(activity.reports).toEqual([]);
  });
});

describe('the note’s thumbnail', () => {
  const withCover = (cover: string) =>
    `---\ntype: artifact\nsaved: artifacts/q3\ncover: ${cover}\n---\n`;

  it('regenerates as asked, says so while it runs, and loads the remade picture afresh', async () => {
    const { fs } = memoryVault({
      [NOTE_PATH]: withCover('q3/atlas-thumbnail.png'),
      'artifacts/q3/index.html': '<p>hi</p>',
    });
    const { hook, jobs, finish } = copyHook(fs, await open(fs));
    await waitFor(() => expect(hook.result.current?.thumbnail.canGenerate).toBe(true));
    expect(hook.result.current?.thumbnail.shown).toBe('q3/atlas-thumbnail.png');

    act(() => hook.result.current?.thumbnail.regenerate());
    expect(jobs).toEqual([{ path: NOTE_PATH, asked: true }]);
    expect(hook.result.current?.thumbnail.generating).toBe(true);

    await act(async () => finish[0]?.());
    await waitFor(() => expect(hook.result.current?.thumbnail.generating).toBe(false));
    expect(hook.result.current?.thumbnail.shown).toBe('q3/atlas-thumbnail.png#1');
  });

  it('clears the cover through the pane, as cleared on purpose so no run puts it back', async () => {
    const { fs } = memoryVault({ [NOTE_PATH]: withCover('photos/me.jpg') });
    const { hook, setProperties } = copyHook(fs, await open(fs));
    expect(hook.result.current?.thumbnail.cover).toBe('photos/me.jpg');
    act(() => hook.result.current?.thumbnail.clear());
    expect(setProperties).toHaveBeenCalledWith({ cover: false });
  });

  it('offers nothing to picture when there is no copy', async () => {
    const { fs } = memoryVault({ [NOTE_PATH]: '---\ntype: artifact\n---\n' });
    const { hook } = copyHook(fs, await open(fs));
    await waitFor(() => expect(hook.result.current?.copy.kind).toBe('none'));
    expect(hook.result.current?.thumbnail).toMatchObject({
      cover: null,
      shown: null,
      canGenerate: false,
    });
  });
});

describe('useNewArtifact', () => {
  function newArtifact(fs: VaultFsPort) {
    const onCreated = vi.fn();
    const thumbnails = { request: vi.fn(async () => null) };
    const index = fakeIndexPort({
      notesOfType: async () => [{ path: 'Projects/DFAI.md', title: 'DFAI' }],
    });
    const activity = recordingActivity();
    const hook = renderHook(() =>
      useNewArtifact({
        activity,
        thumbnails,
        fs,
        markdown: remarkMarkdown,
        index,
        clock: CLOCK,
        indexKey: 'ready:1',
        onCreated,
      }),
    );
    return { hook, onCreated, thumbnails, activity };
  }

  it('guesses the kind from a pasted link, until one is chosen', async () => {
    const { hook } = newArtifact(memoryVault({}).fs);
    await waitFor(() =>
      expect(hook.result.current.projects).toEqual([{ value: 'DFAI', label: 'DFAI' }]),
    );

    act(() => hook.result.current.start('https://claude.ai/artifact/launch-deck'));
    expect(hook.result.current.draft.kind).toBe('deck');

    act(() => hook.result.current.change({ ...hook.result.current.draft, kind: 'doc' }));
    act(() =>
      hook.result.current.change({ ...hook.result.current.draft, url: 'https://x.dev/slides' }),
    );
    expect(hook.result.current.draft.kind).toBe('doc');
  });

  it('names the artifact after a dropped page and guesses its kind from it', async () => {
    const { hook } = newArtifact(memoryVault({}).fs);
    act(() => hook.result.current.start());
    const page = new File(['<article><p>x</p></article>'], 'Handbook.html');
    act(() => hook.result.current.change({ ...hook.result.current.draft, files: [page] }));
    expect(hook.result.current.draft.title).toBe('Handbook');
    await waitFor(() => expect(hook.result.current.draft.kind).toBe('doc'));
  });

  it('saves the note and its copy, hands on where it went, and has the copy pictured', async () => {
    const vault = memoryVault({});
    const { hook, onCreated, thumbnails } = newArtifact(vault.fs);
    act(() => hook.result.current.start(LINK));
    act(() =>
      hook.result.current.change({
        ...hook.result.current.draft,
        title: 'Q3',
        project: 'DFAI',
        files: [new File(['<p>hi</p>'], 'index.html')],
      }),
    );

    await act(() => hook.result.current.create());

    expect(onCreated).toHaveBeenCalledWith('artifacts/Q3.md');
    expect(vault.text.get('artifacts/Q3.md')).toContain(`url: ${LINK}`);
    expect(vault.text.get('artifacts/Q3.md')).toContain('[[DFAI]]');
    expect(vault.bytes.has('artifacts/q3/index.html')).toBe(true);
    expect(hook.result.current.error).toBeNull();
    expect(thumbnails.request).toHaveBeenCalledWith({ path: 'artifacts/Q3.md', asked: false });
  });

  it('asks for no picture when only the link is kept', async () => {
    const vault = memoryVault({});
    const { hook, onCreated, thumbnails } = newArtifact(vault.fs);
    act(() => hook.result.current.start(LINK));
    act(() => hook.result.current.change({ ...hook.result.current.draft, title: 'Q3' }));
    await act(() => hook.result.current.create());
    expect(onCreated).toHaveBeenCalledWith('artifacts/Q3.md');
    expect(thumbnails.request).not.toHaveBeenCalled();
  });

  it('keeps a refusal in the dialog', async () => {
    const { hook, onCreated } = newArtifact(memoryVault({}).fs);
    act(() => hook.result.current.start());
    act(() =>
      hook.result.current.change({
        ...hook.result.current.draft,
        title: 'X',
        files: [new File(['x'], 'a.css')],
      }),
    );
    await act(() => hook.result.current.create());
    expect(hook.result.current.error).toMatch(/no page to open/);
    expect(onCreated).not.toHaveBeenCalled();
    expect(hook.result.current.saving).toBe(false);
  });

  it('records an artifact that could not be saved, once, and nothing for a refusal or a save', async () => {
    const vault = memoryVault({});
    vault.fs.createNote = async () => {
      throw new Error('The disk is full.');
    };
    const failing = newArtifact(vault.fs);
    act(() => failing.hook.result.current.start(LINK));
    act(() =>
      failing.hook.result.current.change({ ...failing.hook.result.current.draft, title: 'Q3' }),
    );
    await act(() => failing.hook.result.current.create());
    expect(failing.hook.result.current.error).toBe('The disk is full.');
    expect(failing.activity.reports).toEqual([
      {
        level: 'error',
        kind: 'save',
        message: 'Could not save the artifact. The disk is full.',
        subject: null,
      },
    ]);

    const { hook, onCreated, activity } = newArtifact(memoryVault({}).fs);
    act(() => hook.result.current.start());
    act(() =>
      hook.result.current.change({
        ...hook.result.current.draft,
        title: 'X',
        files: [new File(['x'], 'a.css')],
      }),
    );
    await act(() => hook.result.current.create());
    expect(hook.result.current.error).toMatch(/no page to open/);
    act(() => hook.result.current.start(LINK));
    act(() => hook.result.current.change({ ...hook.result.current.draft, title: 'Q3' }));
    await act(() => hook.result.current.create());
    expect(onCreated).toHaveBeenCalledWith('artifacts/Q3.md');
    expect(activity.reports).toEqual([]);
  });
});
