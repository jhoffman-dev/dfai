/**
 * Attack on PR #602 (#108): POST /v1/today/choose must never write over a
 * `focus` that is the person's own — a Task type that declares `focus` as
 * text, or one that took `focus` off — nor accept a hostile body.
 */
import { describe, expect, it } from 'vitest';
import { apiFixture, bodyOf, codeOf } from '../testing/api-fixture.ts';

const note = (lines: readonly string[], body = '\nWrite the chapter.\n') =>
  ['---', ...lines, '---', body].join('\n');

const TEXT_FOCUS_TYPE = [
  '---',
  'name: task',
  'properties:',
  '  status: select',
  '  focus:',
  '    kind: text',
  '    label: Focus area',
  '---',
  '',
].join('\n');

const NO_FOCUS_TYPE = ['---', 'name: task', 'properties:', '  status: select', '---', ''].join(
  '\n',
);

const WRITING = note(['type: task', 'status: next-action', 'focus: writing']);

const choose = (api: ReturnType<typeof apiFixture>, body: unknown) =>
  api.send({ method: 'POST', path: '/v1/today/choose', body });

describe('POST /v1/today/choose, against a focus of the person’s own', () => {
  it('leaves a text focus alone when the Task type declares focus as text', async () => {
    const api = apiFixture({
      files: { '.atlas/types/task.md': TEXT_FOCUS_TYPE, 'Tasks/Chapter.md': WRITING },
    });

    await choose(api, { path: 'Tasks/Chapter.md', chosen: true });
    await choose(api, { path: 'Tasks/Chapter.md', chosen: false });

    expect(api.files.get('Tasks/Chapter.md')?.text).toBe(WRITING);
  });

  it('leaves a focus alone when the Task type has taken focus off', async () => {
    const api = apiFixture({
      files: { '.atlas/types/task.md': NO_FOCUS_TYPE, 'Tasks/Chapter.md': WRITING },
    });

    await choose(api, { path: 'Tasks/Chapter.md', chosen: false });

    expect(api.files.get('Tasks/Chapter.md')?.text).toBe(WRITING);
  });
});

describe('POST /v1/today/choose, hostile bodies', () => {
  const PLAIN = note(['type: task', 'status: next-action']);

  it('refuses chosen as the string "true", writing nothing', async () => {
    const api = apiFixture({ files: { 'Tasks/Plain.md': PLAIN } });

    expect(codeOf(await choose(api, { path: 'Tasks/Plain.md', chosen: 'true' }))).toBe('invalid');
    expect(api.files.get('Tasks/Plain.md')?.text).toBe(PLAIN);
  });

  it('refuses a path outside the vault, writing nothing', async () => {
    const api = apiFixture({ files: { 'Tasks/Plain.md': PLAIN } });

    for (const path of ['../Tasks/Plain.md', 'Tasks/../../Plain.md', '/etc/hosts', '']) {
      const response = await choose(api, { path, chosen: true });
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
    expect(api.files.get('Tasks/Plain.md')?.text).toBe(PLAIN);
  });

  it('is idempotent: choosing twice writes the file once', async () => {
    const api = apiFixture({ files: { 'Tasks/Plain.md': PLAIN } });

    await choose(api, { path: 'Tasks/Plain.md', chosen: true });
    const once = api.files.get('Tasks/Plain.md')?.text;
    const again = await choose(api, { path: 'Tasks/Plain.md', chosen: true });

    expect(again.status).toBe(200);
    expect(bodyOf(again)['note']).toMatchObject({ path: 'Tasks/Plain.md' });
    expect(api.files.get('Tasks/Plain.md')?.text).toBe(once);
  });

  it('unchoosing a task never chosen leaves it byte for byte', async () => {
    const api = apiFixture({ files: { 'Tasks/Plain.md': PLAIN } });

    expect((await choose(api, { path: 'Tasks/Plain.md', chosen: false })).status).toBe(200);
    expect(api.files.get('Tasks/Plain.md')?.text).toBe(PLAIN);
  });
});

describe('POST /v1/today/choose, racing the disk', () => {
  const PLAIN = note(['type: task', 'status: next-action']);
  const EDITED = `${PLAIN}edited on the other Mac\n`;

  it('is a conflict, keeping the other edit, when the task changes between its read and the write', async () => {
    const api = apiFixture({ files: { 'Tasks/Plain.md': PLAIN } });
    const reading = api.deps.fs.readTextFile;
    let reads = 0;
    api.deps = {
      ...api.deps,
      fs: {
        ...api.deps.fs,
        readTextFile: async (path) => {
          const read = await reading(path);
          reads += 1;
          if (reads === 1) api.files.set('Tasks/Plain.md', { text: EDITED, modified: 999 });
          return read;
        },
      },
    };

    const response = await choose(api, { path: 'Tasks/Plain.md', chosen: true });

    expect(codeOf(response)).toBe('conflict');
    expect(api.files.get('Tasks/Plain.md')?.text).toBe(EDITED);
  });

  it('writes nothing when no vault is open', async () => {
    const api = apiFixture({ files: { 'Tasks/Plain.md': PLAIN } });
    api.open = null;

    const response = await choose(api, { path: 'Tasks/Plain.md', chosen: true });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(api.writes).toEqual([]);
  });
});
