import { buildAiIndex, type IndexFile } from './index.ts';

const MAX_FILE_BYTES = 60 * 1024;

/** A small seeded generator, so the vault is the same on every run. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

const SENTENCE =
  'A working note about the Larkspur Payroll ledger cutover, written while the plan was still moving and the dates were not yet fixed.';

/** 2,000 notes shaped like a real vault: big meeting and inbox folders, people everyone links. */
function generatedVault(): IndexFile[] {
  const random = seeded(42);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const people = Array.from({ length: 150 }, (_, at) => `Person ${at}`);
  const tags = Array.from({ length: 60 }, (_, at) => `area/topic${at}`);
  const notes: IndexFile[] = people.map((name) => ({
    path: `People/${name}.md`,
    text: `${name} works with Mara Quill and Tobias Fenn. #person\n`,
  }));
  const body = (): string =>
    `${SENTENCE} #${pick(tags)} #${pick(tags)}\n\nSee [[${pick(people)}]], [[${pick(people)}]], [[Project ${Math.floor(random() * 300)}]] and [[Idea ${Math.floor(random() * 500)}]].\n`;
  for (let at = 0; at < 900; at += 1) {
    const year = 2024 + (at % 3);
    const month = String((at % 12) + 1).padStart(2, '0');
    const day = String((at % 28) + 1).padStart(2, '0');
    notes.push({
      path: `Meetings/${year}/${month}/${year}-${month}-${day} Sync ${at}.md`,
      text: `${SENTENCE} #meeting\n\n- With: [[${pick(people)}]], [[${pick(people)}]]\n- About: [[Project ${at % 300}]]\n`,
    });
  }
  for (let at = 0; at < 300; at += 1) {
    notes.push({ path: `Projects/Group ${at % 6}/Project ${at}.md`, text: body() });
  }
  for (let at = 0; at < 500; at += 1) notes.push({ path: `Inbox/Idea ${at}.md`, text: body() });
  for (let at = 0; at < 150; at += 1) notes.push({ path: `Resources/Ref ${at}.md`, text: body() });
  return notes;
}

describe('buildAiIndex on a 2,000-note vault', () => {
  const vault = generatedVault();
  const files = buildAiIndex(vault);

  it('keeps every index file under 60 KB', () => {
    const largest = Math.max(...files.map(({ text }) => new TextEncoder().encode(text).length));
    expect(vault).toHaveLength(2000);
    expect(largest).toBeLessThan(MAX_FILE_BYTES);
  });

  it('splits a big folder by sub-folder and a big flat folder into parts, and lists every note once', () => {
    const paths = files.map(({ path }) => path);
    expect(paths).toContain('_index/folders/Meetings/2024.md');
    expect(paths).toContain('_index/folders/Inbox/part-1.md');
    expect(files.find(({ path }) => path === '_index/folders/Inbox.md')?.text).toMatch(
      /^_index\/folders\/Inbox\/part-2\.md \| \d+ \| Inbox\//m,
    );
    const listed = files
      .filter(({ path }) => path.startsWith('_index/folders/'))
      .flatMap(({ text }) => text.split('\n'))
      .filter((line) => /^[^#_].*\.md( \||$)/.test(line) && !line.startsWith('Line:'));
    expect(new Set(listed.map((line) => line.split(' | ')[0])).size).toBe(2000);
    expect(listed).toHaveLength(2000);
  });
});
