/**
 * A seeded property test (#913): a task's priority set and then cleared
 * through the app's own write and markdown leaves the note byte for byte as
 * it was, whatever else its frontmatter holds — comments, lists, odd quoting,
 * CRLF — and setting it changes no other line.
 */
import { describe, expect, it } from 'vitest';
import { splitFrontmatter, TASK_PRIORITIES } from '@dfai/domain';
import { seededRandom } from '@dfai/domain/testing';
import { fakeVaultFs, memoryVault, setNoteProperties } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';

const PATH = 'Tasks/Water the plants.md';

/** Lines a task's frontmatter may hold besides its type, as people and tools write them. */
const EXTRA_LINES: readonly string[] = [
  'status: next-action',
  "status: 'waiting'   # until Mara replies",
  'due: 2026-11-20',
  'defer: 2026-11-19T09:00',
  'contexts:\n  - "@home"\n  - "@phone"',
  'contexts: [ "@errands" ]',
  'project: "[[Larkspur Payroll]]"',
  'waiting_on: [[Tobias Fenn]]',
  'estimate: 30',
  'aliases: []',
  '# a comment line of its own',
  'source: https://example.com/ticket?id=1&x=y',
  'recurrence: every week',
  'focus: deep work',
  'empty:',
];

const BODIES: readonly string[] = [
  '',
  '\n# Water the plants\n',
  '\nEvery week, before the weekend.\n\n- [ ] the fern\n- [x] the cactus\n',
  '\n---\nA rule, not frontmatter.\n',
];

function noteText(random: () => number): string {
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)] as T;
  const lines = ['type: task'];
  const count = Math.floor(random() * 5);
  for (let at = 0; at < count; at += 1) lines.push(pick(EXTRA_LINES));
  // Keys repeated by the pick are left out: a note listing a key twice is refused, as it should be.
  const seen = new Set<string>();
  const unique = lines.filter((line) => {
    const key = /^([a-z_]+):/.exec(line)?.[1] ?? line;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const text = ['---', ...unique, '---', pick(BODIES)].join('\n');
  return random() < 0.2 ? text.replace(/\n/g, '\r\n') : text;
}

describe('setting a priority and clearing it again (#913)', () => {
  it('gives back the note byte for byte, and setting it touches no other line', async () => {
    const random = seededRandom(913);
    for (let run = 0; run < 150; run += 1) {
      const before = noteText(random);
      const memory = memoryVault({ [PATH]: before });
      const fs = fakeVaultFs(memory.fs);
      const write = (priority: number | null) =>
        setNoteProperties({
          fs,
          markdown: remarkMarkdown,
          path: PATH,
          values: { priority },
          today: '2026-11-18',
        });
      const priority = TASK_PRIORITIES[Math.floor(random() * TASK_PRIORITIES.length)] ?? 1;

      await write(priority);
      const set = memory.files.get(PATH) ?? '';
      const properties = remarkMarkdown.frontmatterProperties(splitFrontmatter(set).frontmatter);
      expect(properties['priority'], before).toBe(priority);
      const eol = before.includes('\r\n') ? '\r\n' : '\n';
      const added = set.split(eol).filter((line) => !before.split(eol).includes(line));
      expect(added, before).toEqual([`priority: ${priority}`]);

      await write(null);
      expect(memory.files.get(PATH), before).toBe(before);
    }
  });
});
