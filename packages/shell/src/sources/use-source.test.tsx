// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createVaultPath, type VaultEntry } from '@dfai/domain';
import {
  recordingActivity,
  createSourceRefresher,
  fakeIndexPort,
  openNote,
  type OpenNote,
  type VaultFsPort,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { useSource } from './use-source.ts';
import type { SourcePorts } from './source-ports.ts';

const SOURCE_PATH = '.atlas/sources/People.md';

const sourceNote = (interval: number): string =>
  [
    '---',
    'atlas: source',
    'format: csv',
    'file: feeds/people.csv',
    'into: People',
    'type: person',
    'key: id',
    'name: name',
    `interval: ${interval}`,
    '---',
    '',
  ].join('\n');

const PEOPLE = 'id,name\n1,Ada\n';

/** The vault as a map of path to text, which the tests read back after a refresh. */
const vaultWith = (note: string): Record<string, string> => ({
  [SOURCE_PATH]: note,
  'feeds/people.csv': PEOPLE,
});

function fakeFs(files: Record<string, string>): VaultFsPort {
  return {
    listDirectory: async (path) => {
      const prefix = path === '' ? '' : `${path}/`;
      return Object.keys(files)
        .filter((file) => file.startsWith(prefix) && !file.slice(prefix.length).includes('/'))
        .map(
          (file) =>
            ({
              kind: 'file',
              name: file.slice(prefix.length),
              path: createVaultPath(file),
            }) as VaultEntry,
        );
    },
    listFiles: async () => [],
    listNotes: async () => [],
    readNotes: async (paths) =>
      paths.flatMap((path) =>
        files[path] === undefined
          ? []
          : [{ path, text: files[path], modified: 1, size: files[path].length }],
      ),
    readBinaryFile: async () => new ArrayBuffer(0),
    readTextFile: async (path) => {
      const text = files[path];
      if (text === undefined) throw new Error(`no such file: ${path}`);
      return { text, modified: 1 };
    },
    createNote: async ({ path, contents }) => {
      files[path] = contents;
      return 0;
    },
    createFolder: async () => {},
    moveEntry: async () => {},
    trashEntry: async () => {},
    writeBinaryFile: async () => 0,
    writeTextFile: async ({ path, contents }) => {
      files[path] = contents;
      return 2;
    },
  };
}

const sources: SourcePorts = {
  http: {
    get: async () => {
      throw new Error('these tests read a file rather than fetching');
    },
  },
  sqlite: {
    query: () => Promise.reject(new Error('these tests read no SQLite file')),
    pick: async () => null,
  },
  secrets: {
    list: async () => [],
    set: async () => {},
    bind: async () => {},
    remove: async () => {},
  },
};

const VAULT_ROOT = '/Users/me/vault';

async function openSource(fs: VaultFsPort): Promise<OpenNote> {
  return openNote({ fs, markdown: remarkMarkdown, path: createVaultPath(SOURCE_PATH) });
}

const render = (
  note: OpenNote,
  fs: VaultFsPort,
  onChanged: () => void,
  {
    ports = sources,
    setProperty = () => {},
  }: {
    ports?: SourcePorts;
    setProperty?: (key: string, value: unknown) => void;
  } = {},
) => {
  const refresher = createSourceRefresher({ activity: recordingActivity() });
  return renderHook(() =>
    useSource({
      note,
      fs,
      markdown: remarkMarkdown,
      index: fakeIndexPort(),
      sources: ports,
      refresher,
      vaultRoot: VAULT_ROOT,
      setProperty,
      onChanged,
    }),
  );
};

describe('useSource', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('refreshes when asked, and reports what happened', async () => {
    const files = vaultWith(sourceNote(0));
    const fs = fakeFs(files);
    const note = await openSource(fs);
    const { result } = render(note, fs, () => {});

    await act(async () => {
      result.current.refresh();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.report?.created).toBe(1);
    expect(files['People/1.md']).toContain('title: Ada');
  });

  it('fetches with the vault it is open in, whose secrets are the ones sent', async () => {
    const note = [
      '---',
      'atlas: source',
      'format: csv',
      'url: https://example.test/people.csv',
      'into: People',
      'type: person',
      '---',
      '',
    ].join('\n');
    const fs = fakeFs({ [SOURCE_PATH]: note });
    const vaults: string[] = [];
    const ports: SourcePorts = {
      ...sources,
      http: {
        get: async ({ vault }) => {
          vaults.push(vault);
          return PEOPLE;
        },
      },
    };
    const { result } = render(await openSource(fs), fs, () => {}, { ports });

    await act(async () => {
      result.current.refresh();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(vaults).toEqual([VAULT_ROOT]);
  });

  it('sends no secret for a source outside .atlas/sources, and says to move it there', async () => {
    const path = 'Feeds/GitHub.md';
    const note = [
      '---',
      'atlas: source',
      'format: json',
      'url: https://api.github.com/user?token={{secret:github}}',
      'into: People',
      'type: person',
      '---',
      '',
    ].join('\n');
    const fs = fakeFs({ [path]: note });
    const fetched: unknown[] = [];
    const ports: SourcePorts = {
      ...sources,
      http: {
        get: async (request) => {
          fetched.push(request);
          return '[]';
        },
      },
    };
    const opened = await openNote({ fs, markdown: remarkMarkdown, path: createVaultPath(path) });
    const { result } = render(opened, fs, () => {}, { ports });

    await act(async () => {
      result.current.refresh();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(fetched).toEqual([]);
    expect(result.current.report?.error).toMatch(/move the note there \(System → sources\)/i);
  });

  it('leaves a source with no interval alone until it is asked', async () => {
    const files = vaultWith(sourceNote(0));
    const fs = fakeFs(files);
    const note = await openSource(fs);
    render(note, fs, () => {});

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 60_000);
    });

    expect(files['People/1.md']).toBeUndefined();
  });

  it('refreshes on opening and again once the interval has passed', async () => {
    const files = vaultWith(sourceNote(1));
    const fs = fakeFs(files);
    const note = await openSource(fs);
    const onChanged = vi.fn();
    render(note, fs, onChanged);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onChanged).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it('stops refreshing once the note is closed', async () => {
    const files = vaultWith(sourceNote(1));
    const fs = fakeFs(files);
    const note = await openSource(fs);
    const onChanged = vi.fn();
    const { unmount } = render(note, fs, onChanged);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('is not a source when the note is something else', async () => {
    const files: Record<string, string> = {
      [SOURCE_PATH]: '---\ntitle: Ordinary\n---\n\nProse.\n',
    };
    const fs = fakeFs(files);
    const note = await openSource(fs);
    const { result } = render(note, fs, () => {});

    await act(async () => {
      result.current.refresh();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.source).toBeNull();
    expect(result.current.report).toBeNull();
  });

  describe('a SQLite source', () => {
    const sqliteNote = (file: string) =>
      [
        '---',
        'atlas: source',
        'format: sqlite',
        `file: ${file}`,
        'query: SELECT id, name FROM people',
        'into: People',
        'type: person',
        '---',
        '',
      ].join('\n');

    const openSqlite = async (file: string) => {
      const fs = fakeFs({ [SOURCE_PATH]: sqliteNote(file) });
      return { fs, note: await openSource(fs) };
    };

    const pickerOffering = (picked: string | null): SourcePorts => ({
      ...sources,
      sqlite: { ...sources.sqlite, pick: async () => picked },
    });

    it('names a file picked inside the vault relative to it', async () => {
      const { fs, note } = await openSqlite('data/team.db');
      const setProperty = vi.fn();
      const ports = pickerOffering(`${VAULT_ROOT}/data/other.db`);
      const { result } = render(note, fs, () => {}, { ports, setProperty });

      await act(async () => {
        result.current.chooseFile?.();
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(setProperty).toHaveBeenCalledWith('file', 'data/other.db');
    });

    it('keeps a file picked outside the vault absolute, and says it is outside', async () => {
      const { fs, note } = await openSqlite('/Users/me/app.db');
      const setProperty = vi.fn();
      const ports = pickerOffering('/Users/me/Library/app.db');
      const { result } = render(note, fs, () => {}, { ports, setProperty });

      expect(result.current.outsideVault).toBe(true);
      await act(async () => {
        result.current.chooseFile?.();
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(setProperty).toHaveBeenCalledWith('file', '/Users/me/Library/app.db');
    });

    it('writes nothing when the dialog is cancelled', async () => {
      const { fs, note } = await openSqlite('data/team.db');
      const setProperty = vi.fn();
      const { result } = render(note, fs, () => {}, { ports: pickerOffering(null), setProperty });

      expect(result.current.outsideVault).toBe(false);
      await act(async () => {
        result.current.chooseFile?.();
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(setProperty).not.toHaveBeenCalled();
      expect(result.current.fileProblem).toBeNull();
    });

    it('says why a file could not be chosen, and writes nothing', async () => {
      const { fs, note } = await openSqlite('data/team.db');
      const setProperty = vi.fn();
      const ports: SourcePorts = {
        ...sources,
        sqlite: { ...sources.sqlite, pick: () => Promise.reject(new Error('unusable file')) },
      };
      const { result } = render(note, fs, () => {}, { ports, setProperty });

      await act(async () => {
        result.current.chooseFile?.();
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(setProperty).not.toHaveBeenCalled();
      expect(result.current.fileProblem).toBe('unusable file');
    });

    it('offers no file to choose for a source that is not SQLite', async () => {
      const fs = fakeFs(vaultWith(sourceNote(0)));
      const { result } = render(await openSource(fs), fs, () => {});

      expect(result.current.source).not.toBeNull();
      expect(result.current.chooseFile).toBeNull();
    });
  });
});
