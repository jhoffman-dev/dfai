import { describe, expect, it } from 'vitest';
import { apiFixture, bodyOf, codeOf, OTHER_VAULT, TODAY } from '../testing/api-fixture.ts';

const TASK_TEMPLATE = '---\ntype: task\nstatus: backlog\n---\n\n## Notes\n';
const DAILY_TEMPLATE = '---\ntype: daily\n---\n\n## Today\n';

/** A vault with a Tasks folder: the host creates notes only in folders that exist. */
const TASKS_FOLDER = { 'Tasks/Existing.md': '# Existing\n' };

const vault = (files: Record<string, string> = {}) =>
  apiFixture({
    files: {
      '.atlas/templates/Task.md': TASK_TEMPLATE,
      '.atlas/templates/Daily.md': DAILY_TEMPLATE,
      ...files,
    },
  });

describe('POST /v1/notes', () => {
  const create = (api: ReturnType<typeof vault>, body: unknown) =>
    api.send({ method: 'POST', path: '/v1/notes', body });

  it('makes an empty Untitled note at the root, answering 201', async () => {
    const api = vault();

    const response = await create(api, {});

    expect(response.status).toBe(201);
    // Its name is its filename; no heading repeats it (U-09).
    expect(api.files.get('Untitled.md')?.text).toBe('');
    expect(bodyOf(response)['note']).toMatchObject({ path: 'Untitled.md', title: 'Untitled' });
  });

  it('numbers each of five unnamed notes made at once, failing none', async () => {
    const api = vault();

    const answers = await Promise.all([1, 2, 3, 4, 5].map(() => create(api, {})));

    expect(answers.map((answer) => answer.status)).toEqual([201, 201, 201, 201, 201]);
    const paths = answers.map((answer) => (bodyOf(answer)['note'] as { path: string }).path);
    expect(new Set(paths).size).toBe(5);
  });

  it('answers conflict, never internal, when every name it tries is taken meanwhile', async () => {
    const api = vault();

    const answers = await Promise.all(Array.from({ length: 40 }, () => create(api, {})));

    const refused = answers.filter((answer) => answer.status !== 201);
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.map(codeOf)).toEqual(refused.map(() => 'conflict'));
  });

  it('numbers an unnamed note when Untitled is taken', async () => {
    const api = vault({ 'Inbox/Untitled.md': '#\n' });
    const response = await create(api, { folder: 'Inbox' });
    expect(bodyOf(response)['note']).toMatchObject({ path: 'Inbox/Untitled 2.md' });
  });

  it('numbers an unnamed note when untitled is taken in another case', async () => {
    const api = vault({ 'untitled.md': '#\n' });
    const response = await create(api, {});
    expect(response.status).toBe(201);
    expect(bodyOf(response)['note']).toMatchObject({ path: 'Untitled 2.md' });
  });

  it.each([[''], ['...'], ['  /  ']])(
    'numbers a note named %j, which is no name, rather than refusing it',
    async (name) => {
      const api = vault({ 'Untitled.md': '#\n' });
      const response = await create(api, { name });
      expect(response.status).toBe(201);
      expect(bodyOf(response)['note']).toMatchObject({ path: 'Untitled 2.md' });
    },
  );

  it('makes a named note in a folder from a template, with properties on top and its own body', async () => {
    const api = vault(TASKS_FOLDER);

    await create(api, {
      folder: 'Tasks',
      name: 'Call Sam',
      template: 'task',
      properties: { status: 'next', due: '2026-10-01' },
      body: '\nRing about the lease.\n',
    });

    expect(api.files.get('Tasks/Call Sam.md')?.text).toBe(
      '---\ntype: task\nstatus: next\ndue: 2026-10-01\n---\n\nRing about the lease.\n',
    );
  });

  it("keeps the template's body when none is given", async () => {
    const api = vault();
    await create(api, { name: 'Call Sam', template: 'Task' });
    expect(api.files.get('Tasks/2026/09/Call Sam.md')?.text).toBe(TASK_TEMPLATE);
  });

  // #214: with no folder named, a typed note goes to its type's home, as the app's New does.
  it('puts a note whose type has a home folder there when no folder is named, and any other at the root', async () => {
    const api = vault();
    await create(api, { name: 'Call Sam', properties: { type: 'task' } });
    await create(api, { name: 'Loose thought' });
    await create(api, { name: 'Soup', properties: { type: 'recipe' } });

    expect(api.files.has('Tasks/2026/09/Call Sam.md')).toBe(true);
    expect(api.files.has('Loose thought.md')).toBe(true);
    expect(api.files.has('Soup.md')).toBe(true);
  });

  it('makes a task from a template holding a priority of its own, as written (#917 review)', async () => {
    for (const line of ['priority: high', 'priority: 7', 'priority: "2"']) {
      const template = `---\ntype: task\nstatus: backlog\n${line}\n---\n\n## Notes\n`;
      const api = vault({ '.atlas/templates/Task.md': template });
      const response = await create(api, { name: 'Call Sam', template: 'Task' });
      expect(response.status).toBe(201);
      expect(api.files.get('Tasks/2026/09/Call Sam.md')?.text).toBe(template);
    }
  });

  it('removes a template property set to null', async () => {
    const api = vault();
    await create(api, { name: 'Call Sam', template: 'Task', properties: { status: null } });
    expect(api.files.get('Tasks/2026/09/Call Sam.md')?.text).toBe(
      '---\ntype: task\n---\n\n## Notes\n',
    );
  });

  it('makes a note from a template kept in a subfolder, or saved as .markdown (ADR-0026)', async () => {
    const api = vault({
      '.atlas/templates/People/Person.md': '---\ntype: person\n---\n\n## Met\n',
      '.atlas/templates/Recipe.markdown': '---\ntype: recipe\n---\n\n## Steps\n',
    });

    await create(api, { name: 'Ann', template: 'person' });
    await create(api, { name: 'Soup', template: 'Recipe' });

    expect(api.files.get('People/Ann.md')?.text).toBe('---\ntype: person\n---\n\n## Met\n');
    expect(api.files.get('Soup.md')?.text).toBe('---\ntype: recipe\n---\n\n## Steps\n');
  });

  it('takes the template nearer the top of the folder when two share a name', async () => {
    const api = vault({ '.atlas/templates/Old/Task.md': '---\ntype: old\n---\n' });
    await create(api, { name: 'Call Sam', template: 'Task' });
    expect(api.files.get('Tasks/2026/09/Call Sam.md')?.text).toBe(TASK_TEMPLATE);
  });

  it('finds a template however its name is normalized, as the Mac disk does', async () => {
    const api = vault({
      [`.atlas/templates/${'Café'.normalize('NFC')}.md`]: '---\ntype: place\n---\n',
    });
    const response = await create(api, { name: 'Corner', template: 'Café'.normalize('NFD') });
    expect(response.status).toBe(201);
    expect(api.files.get('Corner.md')?.text).toBe('---\ntype: place\n---\n');
  });

  it('cleans a name with slashes into a file name in its folder, never another folder', async () => {
    const api = vault(TASKS_FOLDER);
    const response = await create(api, { folder: 'Tasks', name: 'a/../../evil' });
    expect(bodyOf(response)['note']).toMatchObject({ path: 'Tasks/a .. .. evil.md' });
  });

  // Before A15-02 this cleaned to the hidden `.. evil.md` and was refused; the
  // cleaning now strips dots and spaces together, so no name comes out hidden.
  it('cleans a name that climbs into a visible note in its folder', async () => {
    const api = vault(TASKS_FOLDER);
    const response = await create(api, { folder: 'Tasks', name: '../../evil' });
    expect(bodyOf(response)['note']).toMatchObject({ path: 'Tasks/evil.md' });
  });

  it.each([
    ['at the root', 'Nowhere'],
    ['inside a folder that exists', 'Tasks/Nowhere'],
  ])('answers not_found, naming it, for a folder that does not exist %s', async (_, folder) => {
    const api = vault(TASKS_FOLDER);

    const response = await create(api, { folder, name: 'Call Sam' });

    expect(codeOf(response)).toBe('not_found');
    expect(response.status).toBe(404);
    expect(bodyOf(response)['error']).toMatchObject({
      message: `The folder "${folder}" does not exist`,
    });
    expect(api.writes).toEqual([]);
  });

  it('refuses a name that makes something other than a .md note, writing nothing', async () => {
    const api = vault();

    const response = await create(api, { folder: 'Tasks', name: 'notes.markdown' });

    expect(codeOf(response)).toBe('invalid');
    expect(JSON.stringify(response.body)).toContain('name');
    expect(api.writes).toEqual([]);
  });

  it('is exists, writing nothing, when a note is already at the named path', async () => {
    const api = vault({ 'Call Sam.md': 'mine\n' });

    const response = await create(api, { name: 'Call Sam' });

    expect(codeOf(response)).toBe('exists');
    expect(response.status).toBe(409);
    expect(api.files.get('Call Sam.md')?.text).toBe('mine\n');
  });

  it('is exists when another program makes the note between the check and the create', async () => {
    const api = vault();
    const creating = api.deps.fs.createNote;
    api.deps = {
      ...api.deps,
      fs: {
        ...api.deps.fs,
        createNote: async (args) => {
          api.files.set('Call Sam.md', { text: 'theirs\n', modified: 1 });
          return creating(args);
        },
      },
    };

    const response = await create(api, { name: 'Call Sam' });

    expect(codeOf(response)).toBe('exists');
    expect(api.files.get('Call Sam.md')?.text).toBe('theirs\n');
  });

  it('is no_vault, not exists, when the vault switched and the other one has that note', async () => {
    const api = vault();
    const creating = api.deps.fs.createNote;
    api.deps = {
      ...api.deps,
      fs: {
        ...api.deps.fs,
        createNote: async (args) => {
          api.open = OTHER_VAULT;
          api.files.set('Call Sam.md', { text: 'the other vault’s\n', modified: 1 });
          return creating(args);
        },
      },
    };

    const response = await create(api, { name: 'Call Sam' });

    expect(codeOf(response)).toBe('no_vault');
  });

  it('numbers an unnamed note again when Untitled is taken between listing and creating', async () => {
    const api = vault();
    const creating = api.deps.fs.createNote;
    let raced = false;
    api.deps = {
      ...api.deps,
      fs: {
        ...api.deps.fs,
        createNote: async (args) => {
          if (!raced) {
            raced = true;
            api.files.set('Untitled.md', { text: 'theirs\n', modified: 1 });
          }
          return creating(args);
        },
      },
    };

    const response = await create(api, {});

    expect(response.status).toBe(201);
    expect(bodyOf(response)['note']).toMatchObject({ path: 'Untitled 2.md' });
    expect(api.files.get('Untitled.md')?.text).toBe('theirs\n');
  });

  it('is no_vault, not another vault’s note, when the vault switches before the read-back', async () => {
    const api = vault();
    const creating = api.deps.fs.createNote;
    api.deps = {
      ...api.deps,
      fs: {
        ...api.deps.fs,
        createNote: async (args) => {
          await creating(args);
          api.open = OTHER_VAULT;
          return 0;
        },
      },
    };

    const response = await create(api, { name: 'Call Sam' });

    expect(codeOf(response)).toBe('no_vault');
  });

  it.each([
    ['in another case', 'tasks', 'Tasks'],
    ['decomposed (NFD)', 'Café'.normalize('NFD'), 'Café'],
  ])(
    'makes the note in a folder named %s as the vault spells it, and answers with that spelling',
    async (_, asked, held) => {
      const api = apiFixture({ files: { [`${held}/Existing.md`]: 'x\n' }, caseInsensitive: true });

      const response = await create(api, { folder: asked, name: 'Call Sam' });

      expect(response.status).toBe(201);
      expect(bodyOf(response)['note']).toMatchObject({ path: `${held}/Call Sam.md` });
      expect(api.writes.map((write) => write.path)).toEqual([`${held}/Call Sam.md`]);
    },
  );

  it('is internal when the create fails and nothing is there', async () => {
    const api = vault();
    api.deps = {
      ...api.deps,
      fs: {
        ...api.deps.fs,
        createNote: async () => {
          throw new Error('disk full');
        },
      },
    };
    const response = await create(api, { name: 'Call Sam' });
    expect(codeOf(response)).toBe('internal');
  });

  it('is not_found for a template the vault does not have', async () => {
    const api = vault();
    const response = await create(api, { name: 'x', template: 'Recipe' });
    expect(codeOf(response)).toBe('not_found');
    expect(api.writes).toEqual([]);
  });

  it.each([
    ['a body that is not an object', 'hello', 'body'],
    ['a folder that is not a string', { folder: 3 }, 'folder'],
    ['a folder that climbs out', { folder: '../x' }, 'folder'],
    ['a folder in .atlas', { folder: '.atlas/templates' }, 'folder'],
    ['a folder in a hidden folder', { folder: 'Notes/.hidden' }, 'folder'],
    ['a name that is not a string', { name: ['x'] }, 'name'],
    ['a template that is not a string', { template: true }, 'template'],
    ['properties that are not an object', { properties: 'status: x' }, 'properties'],
    ['a body field that is not a string', { body: { text: 'x' } }, 'body'],
  ])('refuses %s as invalid, naming the field', async (_, body, field) => {
    const api = vault();

    const response = await create(api, body);

    expect(codeOf(response)).toBe('invalid');
    expect(JSON.stringify(response.body)).toContain(field);
    expect(api.writes).toEqual([]);
  });
});

describe('POST /v1/daily', () => {
  it("makes today's note in the Daily home folder from the Daily template, answering 201", async () => {
    const api = vault();

    const response = await api.send({ method: 'POST', path: '/v1/daily' });

    expect(response.status).toBe(201);
    expect(api.files.get(`Daily/2026/${TODAY}.md`)?.text).toBe(DAILY_TEMPLATE);
    expect(bodyOf(response)['note']).toMatchObject({
      path: `Daily/2026/${TODAY}.md`,
      type: 'daily',
    });
  });

  it('answers 200 with the note as it is when it is already there', async () => {
    const api = vault({ [`${TODAY}.md`]: 'already\n' });

    const response = await api.send({ method: 'POST', path: '/v1/daily' });

    expect(response.status).toBe(200);
    expect(bodyOf(response)['note']).toMatchObject({ body: 'already\n' });
    expect(api.writes).toEqual([]);
  });
});

describe('POST /v1/capture', () => {
  const capture = (api: ReturnType<typeof vault>, body: unknown) =>
    api.send({ method: 'POST', path: '/v1/capture', body });

  it('makes a task named by the text, from the Task template, in the Inbox (P30-01)', async () => {
    const api = vault();

    const response = await capture(api, { text: 'Renew the passport' });

    expect(response.status).toBe(201);
    expect(api.files.get('Inbox/Renew the passport.md')?.text).toBe(TASK_TEMPLATE);
  });

  it('numbers the task rather than refusing when the name is taken, as quick capture does', async () => {
    const api = vault({ 'Inbox/Renew the passport.md': 'older\n' });
    const response = await capture(api, { text: 'Renew the passport' });
    expect(bodyOf(response)['note']).toMatchObject({ path: 'Inbox/Renew the passport 2.md' });
  });

  it('makes a plain note when the vault has no Task template', async () => {
    const api = apiFixture();
    await capture(api, { text: 'Call Sam' });
    expect(api.files.get('Inbox/Call Sam.md')?.text).toBe('');
  });

  it.each([
    ['no text', {}],
    ['text that is only spaces', { text: '   ' }],
    ['text that is not a string', { text: 7 }],
  ])('refuses %s as invalid', async (_, body) => {
    const api = vault();
    const response = await capture(api, body);
    expect(codeOf(response)).toBe('invalid');
    expect(JSON.stringify(response.body)).toContain('text');
    expect(api.writes).toEqual([]);
  });
});
