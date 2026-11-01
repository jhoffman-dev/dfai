/**
 * The sync invariant as a property (A29-01): two Macs edit, create, rename,
 * delete and re-case files in a random order, syncing now and then, and then
 * sync until they agree. Whatever the order:
 *
 * - every version anyone wrote survives, whole, in some file — unless the Mac
 *   that wrote over it, or deleted it, could see it at the time: that is the
 *   person's own doing, and the only way a version may go;
 * - no file holds conflict markers;
 * - every sync succeeds, and the two Macs end with the same files.
 *
 * Every file is one line, so any two edits of one file conflict: git's line
 * merge never blends two versions into a third that holds neither whole.
 * Seeded, so a failure names the seed and the steps that led to it.
 */
import { mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MARKERS, twoMacs, type Mac } from './two-macs.harness.ts';

// Twelve seeds on every run; more for a deeper search, e.g. SYNC_PROPERTY_SEEDS=200.
const SEEDS = Array.from(
  { length: Number(process.env['SYNC_PROPERTY_SEEDS'] ?? 12) },
  (_, at) => at + 1,
);
const STEPS = 36;

/** mulberry32: a small seeded generator, so each run of a seed is the same run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Names the Macs write to, with case twins and a folder twin among them. */
const NAMES = [
  'a.md',
  'A.md',
  'b.md',
  'Notes/c.md',
  'notes/C.md',
  'Notes/d.md',
  '.atlas/views/v.md',
  'Café.md',
];

const folded = (path: string) => path.normalize('NFC').toLowerCase();

/** One line that no one else ever writes. */
const versionText = (mac: string, number: number) => `${mac} wrote version ${number}\n`;

async function contentsOn(mac: Mac): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const [path, bytes] of await mac.files()) files.set(path, bytes.toString('utf8'));
  return files;
}

function recase(path: string): string {
  const slash = path.lastIndexOf('/');
  const name = path.slice(slash + 1);
  const first = name.charAt(0);
  const flipped = first === first.toUpperCase() ? first.toLowerCase() : first.toUpperCase();
  return `${path.slice(0, slash + 1)}${flipped}${name.slice(1)}`;
}

interface World {
  readonly macs: readonly Mac[];
  /** Every version that must survive. */
  readonly alive: Set<string>;
  readonly log: string[];
  written: number;
}

/** One random thing one Mac does. */
async function act(world: World, random: () => number): Promise<void> {
  const mac = world.macs[Math.floor(random() * world.macs.length)] as Mac;
  const before = await contentsOn(mac);
  const paths = [...before.keys()];
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
  const roll = random();
  if (roll < 0.3) {
    await mac.sync().catch((cause: unknown) => {
      throw new Error(`${mac.name}'s sync failed after ${world.log.join(' / ')}: ${String(cause)}`);
    });
    world.log.push(`${mac.name} syncs`);
    return;
  }
  if (roll < 0.65 || paths.length === 0) {
    const path = paths.length > 0 && random() < 0.5 ? pick(paths) : pick(NAMES);
    world.written += 1;
    const text = versionText(mac.name, world.written);
    await mac.write(path, text);
    world.log.push(`${mac.name} writes ${path}`);
  } else if (roll < 0.8) {
    const path = pick(paths);
    await mac.remove(path);
    world.log.push(`${mac.name} deletes ${path}`);
  } else {
    const from = pick(paths);
    const to = random() < 0.5 ? recase(from) : pick(NAMES);
    // Onto another file that is there already is writing over it, which `writes` covers.
    const taken = paths.some(
      (path) => folded(path) === folded(to) && folded(path) !== folded(from),
    );
    if (taken || from === to) return;
    await mkdir(dirname(join(mac.root, to)), { recursive: true });
    await rename(join(mac.root, from), join(mac.root, to));
    world.log.push(`${mac.name} renames ${from} to ${to}`);
  }
  // What this Mac could see and no longer holds, it wrote over or deleted
  // itself; what it holds that it did not before, it just wrote.
  const held = new Set(before.values());
  const after = new Set((await contentsOn(mac)).values());
  for (const text of held) if (!after.has(text)) world.alive.delete(text);
  for (const text of after) if (!held.has(text)) world.alive.add(text);
}

describe('two Macs doing anything, in any order', () => {
  for (const seed of SEEDS) {
    it(`keeps every version and leaves no markers (seed ${seed})`, async () => {
      const random = seeded(seed);
      const start = await twoMacs({ 'a.md': 'first version\n' });
      const world: World = {
        macs: [start.studio, start.laptop],
        alive: new Set(['first version\n']),
        log: [],
        written: 0,
      };
      for (let step = 0; step < STEPS; step += 1) await act(world, random);
      for (let round = 0; round < 2; round += 1) {
        for (const mac of world.macs) {
          await mac.sync().catch((cause: unknown) => {
            throw new Error(
              `${mac.name}'s last syncs failed after ${world.log.join(' / ')}: ${String(cause)}`,
            );
          });
        }
      }
      const [studio, laptop] = await Promise.all(world.macs.map(contentsOn));
      const everywhere = new Set([...(studio ?? []).values(), ...(laptop ?? []).values()]);
      const lost = [...world.alive].filter((text) => !everywhere.has(text));
      expect(lost, `versions lost after ${world.log.join(' / ')}`).toEqual([]);
      const marked = [...(studio ?? []), ...(laptop ?? [])]
        .filter(([, text]) => MARKERS.test(text))
        .map(([path]) => path);
      expect(marked, `files with markers after ${world.log.join(' / ')}`).toEqual([]);
      const byFoldedPath = (files: Map<string, string> | undefined) =>
        Object.fromEntries([...(files ?? [])].map(([path, text]) => [folded(path), text]));
      expect(byFoldedPath(laptop), `the Macs disagree after ${world.log.join(' / ')}`).toEqual(
        byFoldedPath(studio),
      );
    }, 120_000);
  }
});
