import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { listFiles } from './vault-files.ts';
import { MigrationRefused, migrate, reportLines } from './migrate-from-dfai.ts';
import { convertNote } from './dfai-convert.ts';
import { readFrontmatter } from './frontmatter.ts';

const MEETING = `---
type: meeting
atlas_import: meeting/v1
title: 'Platform weekly sync'
date: '2026-09-29'
start: '10:00'
end: '10:30'
kind: Standup
provider: gemini
external_id: 'gemini-7f3a9c21'
transcript_clock: elapsed
attendees:
  - name: Mara Quill
    email: mara.quill@example.com
  - name: Tobias Fenn
  - name: platform-team
    email: platform-team@example.com
    group: true
---

## Summary

Mara and Tobias agreed to ship the cache behind a flag.

## Transcript

**Mara Quill** [~00:00:00] Morning. ^t0001
`;

const FIXTURE: Record<string, string> = {
  'Inbox/Meetings/2026-09-29 Platform weekly sync (gemini 7f3a9c21).md': MEETING,
  'Contacts/Mara Quill.md':
    '---\ntype: person\nid: p-1\nfavorite: true\nemail: mara.quill@example.com\n---\nLeads payroll at Larkspur Payroll.\n',
  'Projects/Larkspur rollout.md':
    "---\ntype: project\nstatus: active\ndue: '2026-12-01'\ntags: [project, area/finance]\ncreated: 2026-01-02\n---\nMoving the ledger. #project\n\nSee [[2026-09-29 Platform weekly sync (gemini 7f3a9c21)]] and [[Mara Quill]].\n",
  'People/Mara Quill.md': 'An older page with the same name.\n',
  'Resources/Plain.md': 'No frontmatter here.\n',
  'Resources/diagram.png': '\u0089PNG binary-ish',
  '.atlas/state.json': '{}',
  '.atlas-cache/x.md': 'cache',
};

let root: string;
let source: string;
let output: string;

async function put(base: string, path: string, text: string): Promise<void> {
  await mkdir(dirname(join(base, path)), { recursive: true });
  await writeFile(join(base, path), text);
}

async function snapshot(folder: string): Promise<Map<string, string>> {
  const files = await listFiles(folder, new Set());
  return new Map(
    await Promise.all(
      files.map(async ({ path, absolute }) => [path, await readFile(absolute, 'base64')] as const),
    ),
  );
}

const read = (path: string): Promise<string> => readFile(join(output, path), 'utf8');

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lite-migrate-'));
  source = join(root, 'dfai');
  output = join(root, 'lite');
  for (const [path, text] of Object.entries(FIXTURE)) await put(source, path, text);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('migrate', () => {
  it('leaves the source byte for byte as it was', async () => {
    const before = await snapshot(source);
    await migrate(source, output);
    expect(await snapshot(source)).toEqual(before);
  });

  it('moves a meeting to Meetings/<YYYY>/<MM>/ with When, With and #meeting, body kept', async () => {
    await migrate(source, output);
    const text = await read('Meetings/2026/09/2026-09-29 Platform weekly sync.md');
    expect(text.split('\n').slice(0, 6)).toEqual([
      'Mara and Tobias agreed to ship the cache behind a flag. #meeting',
      '',
      '- When: 2026-09-29 10:00–10:30',
      // The link still opens the person it named in DFAI, now renamed by the clash.
      '- With: [[Mara Quill 2]], [[Tobias Fenn]], platform-team',
      '- Kind: Standup',
      '',
    ]);
    expect(text).toContain('## Summary\n');
    expect(text).toContain('**Mara Quill** [~00:00:00] Morning. ^t0001\n');
    expect(text.startsWith('---')).toBe(false);
  });

  it('moves a person to People/, settling a name clash, and records a favourite', async () => {
    const report = await migrate(source, output);
    expect(report.collisions).toEqual(['Contacts/Mara Quill.md → People/Mara Quill 2.md']);
    expect(await read('People/Mara Quill 2.md')).toBe(
      'Leads payroll at Larkspur Payroll.\n\n- Email: mara.quill@example.com\n',
    );
    expect(JSON.parse(await read('.dfai-lite/favorites.json'))).toEqual(['People/Mara Quill 2.md']);
  });

  it('turns tags and informative properties into inline text and re-points links to moved notes', async () => {
    await migrate(source, output);
    expect(await read('Projects/Larkspur rollout.md')).toBe(
      'Moving the ledger. #project\n\n#area/finance\n\n- Status: active\n- Due: 2026-12-01\n\nSee [[2026-09-29 Platform weekly sync]] and [[Mara Quill 2]].\n',
    );
  });

  it('copies other files as they are, skips DFAI state, adds the template and writes the index', async () => {
    const report = await migrate(source, output);
    const paths = [...(await snapshot(output)).keys()];
    expect(paths).toContain('Resources/diagram.png');
    expect(paths.some((path) => path.startsWith('.atlas'))).toBe(false);
    expect(paths).toContain('CLAUDE.md');
    expect(paths).toContain('.github/workflows/index.yml');
    expect(paths).toContain('_index/README.md');
    expect(await read('Resources/Plain.md')).toBe('No frontmatter here.\n');
    expect(report.counts).toMatchObject({
      meeting: 1,
      person: 1,
      frontmatter: 1,
      plain: 2,
      copied: 1,
      favorite: 1,
    });
  });

  it('reports each note that lost a property', async () => {
    const report = await migrate(source, output);
    const lines = reportLines(report, output);
    expect(lines).toContain(
      '  Inbox/Meetings/2026-09-29 Platform weekly sync (gemini 7f3a9c21).md: type, atlas_import, provider, external_id, transcript_clock',
    );
    expect(lines).toContain('  Projects/Larkspur rollout.md: type, created');
  });

  it('refuses an output folder that is not empty, or is inside the source', async () => {
    await put(output, 'keep.md', 'mine');
    await expect(migrate(source, output)).rejects.toBeInstanceOf(MigrationRefused);
    await expect(migrate(source, join(source, 'out'))).rejects.toThrow(/inside the DFAI vault/);
    expect(await readFile(join(output, 'keep.md'), 'utf8')).toBe('mine');
  });
});

describe('readFrontmatter', () => {
  it('reads scalars, quoted text, lists in both forms and lists of maps', () => {
    const { properties, body } = readFrontmatter(
      "---\ntitle: 'Mara''s 1:1'\nnote: \"a #b\"\ndone: false\nempty:\ntags:\n  - one\n  - two\nalso: [x, 'y']\nattendees:\n  - name: Tobias Fenn\n    group: true\n---\nBody.\n",
    );
    expect(Object.fromEntries(properties)).toEqual({
      title: "Mara's 1:1",
      note: 'a #b',
      done: false,
      empty: null,
      tags: ['one', 'two'],
      also: ['x', 'y'],
      attendees: [{ name: 'Tobias Fenn', group: true }],
    });
    expect(body).toBe('Body.\n');
  });

  it('treats a note with no closing --- as having no frontmatter', () => {
    expect(readFrontmatter('---\nnot closed\n').properties.size).toBe(0);
  });
});

describe('convertNote', () => {
  it('reads a comma-separated tags string and skips tags already inline', () => {
    const { text } = convertNote({
      path: 'Inbox/A.md',
      text: "---\ntags: 'a, #b, c'\n---\nAn idea. #c\n",
    });
    expect(text).toBe('An idea. #c\n\n#a #b\n');
  });

  it('keeps a meeting with no usable date where it was, as an ordinary note', () => {
    const converted = convertNote({
      path: 'Inbox/M.md',
      text: '---\ntype: meeting\ntitle: Sync\n---\nMet.\n',
    });
    expect(converted).toMatchObject({ path: 'Inbox/M.md', rule: 'frontmatter' });
    expect(converted.text).toBe('Met.\n\n- Title: Sync\n');
  });
});
