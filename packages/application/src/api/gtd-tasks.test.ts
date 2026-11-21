/**
 * P30-02 (API keeper): a task written through the local API is held to the
 * same GTD rules as one written in the app, and a captured task starts in
 * the Inbox when the vault's Task type has that status (ADR-0029).
 */
import { describe, expect, it } from 'vitest';
import type { MarkdownPort } from '../notes/ports.ts';
import { apiFixture, bodyOf, TODAY } from '../testing/api-fixture.ts';
import { fakeMarkdown } from '../testing/fake-ports.ts';

const GTD_TYPE =
  '---\nname: task\nproperties:\n  status:\n    kind: select\n    options: [inbox, backlog, next-action, in-progress, waiting, someday, longterm, archive]\n    done: archive\n---\n';
const OLD_TYPE =
  '---\nname: task\nproperties:\n  status:\n    kind: select\n    options: [backlog, done]\n    done: done\n---\n';
const TASK_TEMPLATE = '---\ntype: task\nstatus: backlog\n---\n\n## Notes\n';

/** `key: value` lines for notes, and a type file's nested status read out of its text. */
function typeAware(): MarkdownPort {
  const markdown = fakeMarkdown();
  return {
    ...markdown,
    frontmatterProperties: (frontmatter) =>
      frontmatter?.includes('name: task')
        ? {
            name: 'task',
            properties: {
              status: {
                kind: 'select',
                options: /options: \[(.*)\]/.exec(frontmatter)?.[1]?.split(', ') ?? [],
                done: /done: (\S+)/.exec(frontmatter)?.[1],
              },
            },
          }
        : markdown.frontmatterProperties(frontmatter),
  };
}

const OWN_PRIORITY_TYPE = '---\nname: task\nproperties:\n  priority: select\n---\n';

/** `key: value` lines for notes, and a Task type whose `priority` is a select of its own. */
function withOwnPriority(): MarkdownPort {
  const markdown = fakeMarkdown();
  return {
    ...markdown,
    frontmatterProperties: (frontmatter) =>
      frontmatter?.includes('name: task')
        ? { name: 'task', properties: { priority: { kind: 'select', options: ['high', 'low'] } } }
        : markdown.frontmatterProperties(frontmatter),
  };
}

const vault = (type: string, files: Record<string, string> = {}) =>
  apiFixture({
    markdown: typeAware(),
    files: { '.atlas/types/task.md': type, '.atlas/templates/Task.md': TASK_TEMPLATE, ...files },
  });

describe('POST /v1/capture, in a vault on GTD', () => {
  it('starts the captured task in the Inbox, the rest of the template as it is', async () => {
    const api = vault(GTD_TYPE);
    const response = await api.send({
      method: 'POST',
      path: '/v1/capture',
      body: { text: 'Call Sam' },
    });
    expect(response.status).toBe(201);
    expect(api.files.get('Inbox/Call Sam.md')?.text).toBe(
      '---\ntype: task\nstatus: inbox\n---\n\n## Notes\n',
    );
  });

  it('keeps the template’s status in a vault still on statuses of its own', async () => {
    const api = vault(OLD_TYPE);
    await api.send({ method: 'POST', path: '/v1/capture', body: { text: 'Call Sam' } });
    expect(api.files.get('Inbox/Call Sam.md')?.text).toBe(TASK_TEMPLATE);
  });
});

describe('PATCH /v1/notes/{path}/properties on a task', () => {
  const TASK = '---\ntype: task\nstatus: next-action\n---\n\n# Call\n';
  const patch = (api: ReturnType<typeof vault>, set: Record<string, unknown>) =>
    api.send({ method: 'PATCH', path: '/v1/notes/Call.md/properties', body: { set } });

  it('sets a priority and takes it out again through the generic route, no new field (#913)', async () => {
    const api = vault(GTD_TYPE, { 'Call.md': TASK });
    expect((await patch(api, { priority: 1 })).status).toBe(200);
    expect(api.files.get('Call.md')?.text).toBe(TASK.replace('---\n\n', 'priority: 1\n---\n\n'));
    expect((await patch(api, { priority: null })).status).toBe(200);
    expect(api.files.get('Call.md')?.text).toBe(TASK);
  });

  it('refuses a priority that is not 1 to 4 as invalid, and writes nothing (#913)', async () => {
    const api = vault(GTD_TYPE, { 'Call.md': TASK });
    const response = await patch(api, { priority: 'high' });
    expect(response.status).toBe(400);
    expect(bodyOf(response)).toMatchObject({ error: { code: 'invalid' } });
    expect(api.files.get('Call.md')?.text).toBe(TASK);
  });

  it('writes a priority of the vault’s own as given, where its Task type keeps priority as a select (#917 review)', async () => {
    const own = apiFixture({
      markdown: withOwnPriority(),
      files: { '.atlas/types/task.md': OWN_PRIORITY_TYPE, 'Call.md': TASK },
    });
    expect((await patch(own, { priority: 'high' })).status).toBe(200);
    expect(own.files.get('Call.md')?.text).toContain('\npriority: high\n');
  });

  it('accepts Waiting with nobody to wait on, writing the status alone (#202)', async () => {
    const api = vault(GTD_TYPE, { 'Call.md': TASK });
    const response = await patch(api, { status: 'waiting' });
    expect(response.status).toBe(200);
    expect(api.files.get('Call.md')?.text).toBe(TASK.replace('next-action', 'waiting'));
  });

  it('lets Waiting through with someone to wait on', async () => {
    const api = vault(GTD_TYPE, { 'Call.md': TASK });
    const response = await patch(api, { status: 'waiting', waiting_on: '[[Mara Quill]]' });
    expect(response.status).toBe(200);
    expect(bodyOf(response)['note']).toMatchObject({ properties: { status: 'waiting' } });
  });

  it('dates a task set to Archive with today', async () => {
    const api = vault(GTD_TYPE, { 'Call.md': TASK });
    await patch(api, { status: 'archive' });
    expect(api.files.get('Call.md')?.text).toBe(
      `---\ntype: task\nstatus: archive\ncompleted: ${TODAY}\n---\n\n# Call\n`,
    );
  });
});
