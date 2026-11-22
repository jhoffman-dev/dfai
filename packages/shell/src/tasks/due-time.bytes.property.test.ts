/**
 * A seeded property test (#928): giving a task's due a time and taking it off
 * again, through the app's own write and markdown, never touches another
 * note — a date-only due, a due in some other form, a note that is no task —
 * and taking the time off gives the task back byte for byte as it was.
 */
import { describe, expect, it } from 'vitest';
import { dueWithTime, splitFrontmatter } from '@dfai/domain';
import { seededRandom } from '@dfai/domain/testing';
import { fakeVaultFs, memoryVault, setNoteProperties } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';

const TODAY = '2026-11-21';

/** How a task's due may be written: as the app writes it, and as people do. */
const DUES: readonly string[] = [
  'due: 2026-11-20',
  "due: '2026-11-24'",
  'due: "2026-12-01"   # before the audit',
  'due: 2026-12-04 15:30',
  'due: next Friday',
  'due:\n  - 2026-12-05\n  - 2026-12-06',
];

/** Lines a note may hold besides, as people and tools write them. */
const EXTRA_LINES: readonly string[] = [
  'status: next-action',
  "status: 'waiting'   # until Mara replies",
  'defer: 2026-11-19T09:00',
  'contexts: [ "@errands" ]',
  'project: "[[Larkspur Payroll]]"',
  'recurrence: every week',
  '# a comment line of its own',
];

const BODIES: readonly string[] = ['', '\n# Notes\n', '\n- [ ] call Tobias Fenn\n'];

const TIMES: readonly string[] = ['00:00', '09:05', '15:30', '23:59'];

type Random = () => number;
const pick = <T>(random: Random, items: readonly T[]) =>
  items[Math.floor(random() * items.length)] as T;

function noteText(random: Random, type: string, due: string | null): string {
  const lines = [`type: ${type}`, ...(due === null ? [] : [due])];
  for (let at = Math.floor(random() * 3); at > 0; at -= 1) lines.push(pick(random, EXTRA_LINES));
  const seen = new Set<string>();
  const unique = lines.filter((line) => {
    const key = /^([a-z_]+):/.exec(line)?.[1] ?? line;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const text = ['---', ...unique, '---', pick(random, BODIES)].join('\n');
  return random() < 0.2 ? text.replace(/\n/g, '\r\n') : text;
}

/** A vault of tasks whose dues are edited, beside tasks and notes that never are. */
function vaultOf(random: Random) {
  const edited = ['Tasks/Call Mara Quill.md', 'Tasks/Send the invoice.md'];
  const files: Record<string, string> = {
    [edited[0] as string]: noteText(random, 'task', 'due: 2026-11-20'),
    [edited[1] as string]: noteText(random, 'task', 'due: 2026-12-02'),
    'Tasks/Date only.md': noteText(random, 'task', pick(random, DUES)),
    'Tasks/Another.md': noteText(random, 'task', pick(random, DUES)),
    'Notes/Larkspur Payroll.md': noteText(random, 'note', pick(random, [...DUES, null])),
  };
  return { files, edited };
}

describe('a time set on a due and taken off again (#928)', () => {
  it('leaves every other note byte for byte, and clearing gives the task back as it was', async () => {
    const random = seededRandom(928);
    for (let run = 0; run < 60; run += 1) {
      const { files, edited } = vaultOf(random);
      const memory = memoryVault(files);
      const fs = fakeVaultFs(memory.fs);
      const dueNow = (path: string) =>
        remarkMarkdown.frontmatterProperties(
          splitFrontmatter(memory.files.get(path) ?? '').frontmatter,
        )['due'];
      const write = (path: string, time: string | null) =>
        setNoteProperties({
          fs,
          markdown: remarkMarkdown,
          path,
          values: { due: dueWithTime(dueNow(path), time) },
          today: TODAY,
        });

      const original = new Map(edited.map((path) => [path, dueNow(path)]));
      for (let step = 0; step < 6; step += 1) {
        const path = pick(random, edited);
        const time = random() < 0.6 ? pick(random, TIMES) : null;
        await write(path, time);
        const label = `run ${run}, step ${step}: ${path} ${time ?? 'cleared'}`;
        expect(dueNow(path), label).toBe(dueWithTime(original.get(path), time));
        for (const [other, text] of Object.entries(files)) {
          if (!edited.includes(other)) expect(memory.files.get(other), label).toBe(text);
        }
      }
      for (const path of edited) {
        await write(path, null);
        expect(memory.files.get(path), `run ${run}: ${path} cleared`).toBe(files[path]);
      }
    }
  });
});
