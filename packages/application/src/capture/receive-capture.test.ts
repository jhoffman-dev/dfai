import { describe, expect, it } from 'vitest';
import { CAPTURE_QUERY_MARK, captureFile, readCapture, type VaultPath } from '@dfai/domain';
import { slackCapture } from '@dfai/domain/testing';
import { apiFixture } from '../testing/api-fixture.ts';
import { fakeMarkdown } from '../testing/fake-ports.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import type { QueryResult } from '../index/ports.ts';
import { CapturePathTakenError, receiveCapture } from './receive-capture.ts';

/*
 * The capture use-case (#103) over fake ports: what it writes, where, and
 * when it writes nothing. The real YAML reader and index are the adapters'
 * integration test's.
 */

const CAPTURE = readCapture(slackCapture());
const FILE = captureFile(CAPTURE, { timeZone: 'UTC' });
const OTHER_NOTE = '---\ntype: task\n---\n\nSomething else.\n';

/** `fakeMarkdown`'s `key: value` lines, with a single-quoted value read as YAML reads it. */
function quotedMarkdown(): MarkdownPort {
  const base = fakeMarkdown();
  return {
    ...base,
    frontmatterProperties: (frontmatter) =>
      Object.fromEntries(
        Object.entries(base.frontmatterProperties(frontmatter)).map(([key, value]) => [
          key,
          typeof value === 'string' ? value.replace(/^'(.*)'$/, '$1').replace(/''/g, "'") : value,
        ]),
      ),
  };
}

/** An index whose holders query answers `holders`, and every other query nothing. */
function indexHolding(holders: readonly string[] = []) {
  const asked: string[] = [];
  const query = async (sql: string): Promise<QueryResult> => {
    asked.push(sql);
    return sql.startsWith(CAPTURE_QUERY_MARK)
      ? { columns: ['path'], rows: holders.map((path) => [path]), truncated: false }
      : { columns: [], rows: [], truncated: false };
  };
  return { query, asked };
}

function vault(files: Record<string, string> = {}, holders: readonly string[] = []) {
  const api = apiFixture({ files });
  const index = indexHolding(holders);
  const ports = { fs: api.fs, markdown: quotedMarkdown(), index };
  const receive = () => receiveCapture({ ports, capture: CAPTURE, timeZone: 'UTC' });
  return { api, index, receive };
}

describe('receiveCapture (#103)', () => {
  it('writes a new message into Inbox/Captures, making the folder', async () => {
    const { api, receive } = vault();
    expect(await receive()).toEqual({ path: FILE.path, outcome: 'written' });
    expect(api.files.get(FILE.path)?.text).toBe(FILE.content);
    expect(api.folders.has('Inbox/Captures')).toBe(true);
  });

  it('writes nothing for a message the index says is held, wherever it was filed', async () => {
    const filed = 'Projects/Larkspur/Send the renewal.md';
    const { api, receive } = vault({}, [filed]);
    expect(await receive()).toEqual({
      path: filed as VaultPath,
      outcome: 'in-vault',
    });
    expect(api.writes).toEqual([]);
  });

  it('writes nothing for one written a moment ago that the index has not read yet', async () => {
    const { api, receive } = vault({ [FILE.path]: FILE.content });
    expect(await receive()).toEqual({ path: FILE.path, outcome: 'in-vault' });
    expect(api.writes).toEqual([]);
  });

  it('writes nothing for one written a moment ago under another title, the index not caught up', async () => {
    // n8n titled it from the first line; a pasted link (#105) asks for a title of its own.
    const retitled = captureFile(readCapture(slackCapture({ title: 'Renewal, from Slack' })), {
      timeZone: 'UTC',
    });
    expect(retitled.path).not.toBe(FILE.path);
    const { api, receive } = vault({ [retitled.path]: retitled.content });
    expect(await receive()).toEqual({ path: retitled.path, outcome: 'in-vault' });
    expect(api.writes).toEqual([]);
  });

  it('reads only a file whose name ends in the key, and a note of another message there is not it', async () => {
    const other = captureFile(readCapture(slackCapture({ title: FILE.title })), {
      timeZone: 'UTC',
    }).content.replace('1793136000.000100', '1793136000.000999');
    const { api, receive } = vault({
      [`Inbox/Captures/Unrelated${FILE.keyEnding.replace('.md', '')} notes.md`]: FILE.content,
      [`Inbox/Captures/Copy${FILE.keyEnding}`]: other,
    });
    expect(await receive()).toEqual({ path: FILE.path, outcome: 'written' });
    expect(api.writes).toEqual([{ path: FILE.path, contents: FILE.content }]);
  });

  it('never writes over another note at its path', async () => {
    const { api, receive } = vault({ [FILE.path]: OTHER_NOTE });
    await expect(receive()).rejects.toThrow(CapturePathTakenError);
    await expect(receive()).rejects.toThrow(
      'Another note holds the path of slack C0LARK5PUR/1793136000.000100; not writing it',
    );
    expect(api.files.get(FILE.path)?.text).toBe(OTHER_NOTE);
    expect(api.writes).toEqual([]);
  });

  it('is held when another request writes it between the listing and the write', async () => {
    const api = apiFixture();
    const fs = {
      ...api.fs,
      createNote: async ({ path }: { path: VaultPath }) => {
        await api.fs.createNote({ path, contents: FILE.content });
        throw new Error('the file is there');
      },
    };
    const ports = { fs, markdown: quotedMarkdown(), index: indexHolding() };
    expect(await receiveCapture({ ports, capture: CAPTURE, timeZone: 'UTC' })).toEqual({
      path: FILE.path,
      outcome: 'in-vault',
    });
  });

  it('passes on a write that fails with nothing there', async () => {
    const api = apiFixture();
    const fs = { ...api.fs, createNote: async () => Promise.reject(new Error('disk full')) };
    const ports = { fs, markdown: quotedMarkdown(), index: indexHolding() };
    await expect(receiveCapture({ ports, capture: CAPTURE, timeZone: 'UTC' })).rejects.toThrow(
      'disk full',
    );
  });

  it('passes on an index that cannot be asked, writing nothing', async () => {
    const api = apiFixture();
    const index = { query: async () => Promise.reject(new Error('index closed')) };
    const ports = { fs: api.fs, markdown: quotedMarkdown(), index };
    await expect(receiveCapture({ ports, capture: CAPTURE, timeZone: 'UTC' })).rejects.toThrow(
      'index closed',
    );
    expect(api.writes).toEqual([]);
  });
});
