/**
 * #108 (API keeper): POST /v1/today/choose chooses a task for today, or takes
 * it off, as the Today page's Today, Keep and Drop do — on the app's clock,
 * through the byte-preserving write a property change takes.
 */
import { describe, expect, it } from 'vitest';
import { apiFixture, bodyOf, codeOf, TODAY } from '../testing/api-fixture.ts';

const note = (lines: readonly string[], body = '\nCall about the proofs.\n') =>
  ['---', ...lines, '---', body].join('\n');

const PRINTER = note(['type: task', 'status: next-action', 'due: 2026-09-30']);

const FILES = {
  'Tasks/Call the printer.md': PRINTER,
  'Tasks/Carried.md': note(['type: task', 'status: in-progress', 'focus: 2026-09-21']),
  'Notes/Lease.md': note(['type: note']),
};

const choose = (api: ReturnType<typeof apiFixture>, body: unknown) =>
  api.send({ method: 'POST', path: '/v1/today/choose', body });

const text = (api: ReturnType<typeof apiFixture>, path: string) => api.files.get(path)?.text;

describe('POST /v1/today/choose', () => {
  it('chooses a task for today on the app’s clock, and answers the task', async () => {
    const api = apiFixture({ files: FILES });

    const response = await choose(api, { path: 'Tasks/Call the printer.md', chosen: true });

    expect(response.status).toBe(200);
    expect(bodyOf(response)['note']).toMatchObject({ path: 'Tasks/Call the printer.md' });
    expect(text(api, 'Tasks/Call the printer.md')).toBe(
      note(['type: task', 'status: next-action', 'due: 2026-09-30', `focus: ${TODAY}`]),
    );
  });

  it('gives a task chosen and then taken off back byte for byte', async () => {
    const api = apiFixture({ files: FILES });

    await choose(api, { path: 'Tasks/Call the printer.md', chosen: true });
    expect(text(api, 'Tasks/Call the printer.md')).not.toBe(PRINTER);
    await choose(api, { path: 'Tasks/Call the printer.md', chosen: false });

    expect(text(api, 'Tasks/Call the printer.md')).toBe(PRINTER);
  });

  it('keeps one carried over for today, or drops it', async () => {
    const kept = apiFixture({ files: FILES });
    await choose(kept, { path: 'Tasks/Carried.md', chosen: true });
    expect(text(kept, 'Tasks/Carried.md')).toBe(
      note(['type: task', 'status: in-progress', `focus: ${TODAY}`]),
    );

    const dropped = apiFixture({ files: FILES });
    await choose(dropped, { path: 'Tasks/Carried.md', chosen: false });
    expect(text(dropped, 'Tasks/Carried.md')).toBe(note(['type: task', 'status: in-progress']));
  });

  it('refuses a note that is not a task, writing nothing', async () => {
    const api = apiFixture({ files: FILES });

    const response = await choose(api, { path: 'Notes/Lease.md', chosen: true });

    expect(codeOf(response)).toBe('invalid');
    expect(text(api, 'Notes/Lease.md')).toBe(FILES['Notes/Lease.md']);
  });

  it('refuses a body without a true or false chosen, or without a path', async () => {
    const api = apiFixture({ files: FILES });

    for (const body of [
      { path: 'Tasks/Call the printer.md' },
      { path: 'Tasks/Call the printer.md', chosen: 'yes' },
      { chosen: true },
    ]) {
      expect(codeOf(await choose(api, body))).toBe('invalid');
    }
    expect(text(api, 'Tasks/Call the printer.md')).toBe(PRINTER);
  });

  it('is not_found for a task that is not there', async () => {
    const api = apiFixture({ files: FILES });

    expect(codeOf(await choose(api, { path: 'Tasks/Gone.md', chosen: true }))).toBe('not_found');
  });
});

describe('POST /v1/today/choose, where choosing is not the vault’s (#108 fix round)', () => {
  const typeWith = (focusLines: readonly string[]) =>
    ['---', 'name: task', 'properties:', '  status: select', ...focusLines, '---', ''].join('\n');

  it.each([
    ['declares focus as text', ['  focus:', '    kind: text']],
    ['has taken focus off', []],
  ])('refuses as invalid, writing nothing, when the Task type %s', async (_, lines) => {
    const api = apiFixture({ files: { ...FILES, '.atlas/types/task.md': typeWith(lines) } });

    const response = await choose(api, { path: 'Tasks/Call the printer.md', chosen: true });

    expect(codeOf(response)).toBe('invalid');
    expect(JSON.stringify(response.body)).toContain('Chosen for');
    expect(text(api, 'Tasks/Call the printer.md')).toBe(PRINTER);
  });

  it('refuses as invalid a task whose focus is not one day, writing nothing', async () => {
    const own = note(['type: task', 'status: next-action', 'focus: writing']);
    const api = apiFixture({
      files: {
        '.atlas/types/task.md': typeWith(['  focus: date']),
        'Tasks/Chapter.md': own,
      },
    });

    for (const chosen of [true, false]) {
      expect(codeOf(await choose(api, { path: 'Tasks/Chapter.md', chosen }))).toBe('invalid');
    }
    expect(text(api, 'Tasks/Chapter.md')).toBe(own);
  });
});
