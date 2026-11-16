import { describe, expect, it } from 'vitest';
import { createVaultPath } from '../vault/vault-path.ts';
import { readWikiLink } from '../markdown/wikilink-spans.ts';
import {
  acceptableAtOnce,
  conflictGroups,
  proposalEntries,
  proposalSlotOf,
  proposalValueOf,
  type ConflictGroup,
} from './conflict-groups.ts';
import { PROPOSAL_CONFIDENCES, readProposal, type ProposalNote } from './proposal.ts';

/**
 * Attack on PR #406 (#307, Q12): the conflict-group rule over random proposal
 * sets drawn from a seeded RNG, plus the cases the property runs surfaced.
 */

/** mulberry32: a seeded RNG, so every run draws the same proposals. */
function rngOf(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pickOf =
  (rng: () => number) =>
  <T>(from: readonly T[]): T =>
    from[Math.floor(rng() * from.length)] as T;

function shuffled<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let at = out.length - 1; at > 0; at -= 1) {
    const other = Math.floor(rng() * (at + 1));
    [out[at], out[other]] = [out[other] as T, out[at] as T];
  }
  return out;
}

const STANDUP = 'Inbox/Meetings/2026-10-16 Platform Standup.md';
const REVIEW = 'Inbox/Meetings/2026-10-17 Ledger Review.md';

function proposal(name: string, properties: Record<string, unknown>): ProposalNote {
  const reading = readProposal({
    path: createVaultPath(`Inbox/Proposals/${name}.md`),
    properties: { type: 'proposal', state: 'open', ...properties },
  });
  if (!reading.ok) throw new Error(reading.problem);
  return reading.proposal;
}

const SOURCES = [
  null,
  '[[2026-10-16 Platform Standup]]',
  '[[2026-10-16 Platform Standup#^t0001]]',
  '[[2026-10-16 Platform Standup#^t0002]]',
  '[[2026-10-17 Ledger Review]]',
];
const VALUES = ['Mara Quill', 'Mara Quill (Larkspur)', 'Tobias Fenn'];

function randomProposal(at: number, rng: () => number): ProposalNote {
  const pick = pickOf(rng);
  const source = pick(SOURCES);
  const confidence = pick([...PROPOSAL_CONFIDENCES, null]);
  const note = pick([STANDUP, REVIEW]);
  const property = pick(['people', 'owner']);
  const value = pick(VALUES);
  if (rng() < 0.6) {
    return proposal(`P${at}`, {
      kind: 'link',
      source,
      confidence,
      payload: { note, property, link: `[[${value}]]`, digest: null },
    });
  }
  return proposal(`P${at}`, {
    kind: 'person',
    source,
    confidence,
    payload: {
      title: value,
      folder: 'People',
      properties: {},
      link_from: rng() < 0.2 ? null : { note, property },
    },
  });
}

const drawnSets = new Map<number, readonly ProposalNote[]>();

/** A seed's proposals, drawn once: each property below reads the same 2000 sets. */
function randomSet(seed: number): readonly ProposalNote[] {
  const drawn = drawnSets.get(seed);
  if (drawn !== undefined) return drawn;
  const rng = rngOf(seed);
  const count = 1 + Math.floor(rng() * 9);
  const set = Array.from({ length: count }, (_, at) => randomProposal(at, rng));
  drawnSets.set(seed, set);
  return set;
}

const SEEDS = Array.from({ length: 2000 }, (_, at) => 1000 + at);

/** The pairwise Q12 rule, written out independently of the module under attack. */
function sourceKey(source: string | null) {
  if (source === null) return { note: '', block: null as string | null };
  const link = readWikiLink(source.trim());
  if (link === null) return { note: source.trim().toLowerCase(), block: null };
  return {
    note: link.target.trim().toLowerCase(),
    block: link.heading?.trim().toLowerCase() ?? null,
  };
}
function sameSlotAndSource(a: ProposalNote, b: ProposalNote): boolean {
  const slotA = proposalSlotOf(a);
  const slotB = proposalSlotOf(b);
  if (slotA === null || slotB === null || a.kind !== b.kind) return false;
  if (slotA.note !== slotB.note || slotA.property !== slotB.property) return false;
  const sa = sourceKey(a.source);
  const sb = sourceKey(b.source);
  return sa.note === sb.note && (sa.block === null || sb.block === null || sa.block === sb.block);
}
const conflicts = (a: ProposalNote, b: ProposalNote) =>
  sameSlotAndSource(a, b) && proposalValueOf(a) !== proposalValueOf(b);

const membersOf = (group: ConflictGroup) =>
  group.choices.flatMap((choice) => choice.proposals.map((each) => each.path));

/** Where each proposal is listed: the entry index it stands in. */
function placement(open: readonly ProposalNote[]): Map<string, number> {
  const at = new Map<string, number>();
  proposalEntries(open).forEach((entry, index) => {
    const paths = 'one' in entry ? [entry.one.path] : membersOf(entry.choice);
    for (const path of paths) at.set(path, index);
  });
  return at;
}

/** Groups as sorted sets of member paths, sorted: comparable across input orders. */
const groupSets = (open: readonly ProposalNote[]) =>
  conflictGroups(open)
    .map((group) => membersOf(group).sort().join(','))
    .sort();

describe('conflictGroups — properties over seeded random proposal sets (attack #406)', () => {
  it('lists every open proposal exactly once: on its own or inside one group', () => {
    for (const seed of SEEDS) {
      const open = randomSet(seed);
      const listed = proposalEntries(open).flatMap((entry) =>
        'one' in entry ? [entry.one.path] : membersOf(entry.choice),
      );
      expect([...listed].sort(), `seed ${seed}`).toEqual(open.map((each) => each.path).sort());
    }
  });

  it('keeps one value per choice and different values across a group’s choices', () => {
    for (const seed of SEEDS) {
      for (const group of conflictGroups(randomSet(seed))) {
        expect(group.choices.length, `seed ${seed}`).toBeGreaterThanOrEqual(2);
        const values = group.choices.map((choice) => choice.value);
        expect(new Set(values).size, `seed ${seed}`).toBe(values.length);
        for (const choice of group.choices) {
          for (const member of choice.proposals) {
            expect(proposalValueOf(member), `seed ${seed}`).toBe(choice.value);
          }
        }
      }
    }
  });

  it('gives a group the confidence of its least sure member that says one', () => {
    const rank = (c: string | null) => (c === null ? -1 : PROPOSAL_CONFIDENCES.indexOf(c as never));
    for (const seed of SEEDS) {
      for (const group of conflictGroups(randomSet(seed))) {
        const said = group.choices
          .flatMap((choice) => choice.proposals)
          .map((each) => each.confidence)
          .filter((c) => c !== null);
        const least = said.length === 0 ? null : said.reduce((a, b) => (rank(a) > rank(b) ? a : b));
        expect(group.confidence, `seed ${seed}`).toBe(least);
      }
    }
  });

  it('never lets "Accept all high confidence" take a proposal that stands in a group', () => {
    for (const seed of SEEDS) {
      const open = randomSet(seed);
      const grouped = new Set(conflictGroups(open).flatMap(membersOf));
      for (const path of acceptableAtOnce(proposalEntries(open))) {
        expect(grouped.has(path), `seed ${seed}`).toBe(false);
      }
    }
  });

  it('groups the same proposals whatever order they arrive in', () => {
    const differ: number[] = [];
    for (const seed of SEEDS) {
      const open = randomSet(seed);
      const asArrived = groupSets(open).join('|');
      const rng = rngOf(seed * 7 + 1);
      for (let round = 0; round < 5; round += 1) {
        if (groupSets(shuffled(open, rng)).join('|') !== asArrived) {
          differ.push(seed);
          break;
        }
      }
    }
    expect(differ).toEqual([]);
  });

  it('puts any two proposals that conflict into the same group, never one in a group and one alone', () => {
    const split: number[] = [];
    for (const seed of SEEDS) {
      const open = randomSet(seed);
      const at = placement(open);
      for (const a of open) {
        for (const b of open) {
          if (a !== b && conflicts(a, b) && at.get(a.path) !== at.get(b.path)) split.push(seed);
        }
      }
    }
    expect([...new Set(split)]).toEqual([]);
  });

  it('never accepts two proposals at once that conflict with each other', () => {
    const both: number[] = [];
    for (const seed of SEEDS) {
      const open = randomSet(seed).map((each) => ({ ...each, confidence: 'high' as const }));
      const taken = new Set(acceptableAtOnce(proposalEntries(open)));
      const accepted = open.filter((each) => taken.has(each.path));
      for (const a of accepted) {
        for (const b of accepted) if (a !== b && conflicts(a, b)) both.push(seed);
      }
    }
    expect([...new Set(both)]).toEqual([]);
  });
});

const link = (name: string, to: string, source: string, confidence = 'high') =>
  proposal(name, {
    kind: 'link',
    source,
    confidence,
    payload: { note: STANDUP, property: 'people', link: to, digest: null },
  });

describe('conflictGroups — cases the properties found (attack #406)', () => {
  it('groups a block-level and a note-level citation the same in either order', () => {
    // b1 X, b2 Y, note-only Z: Z sits with both blocks, so all three are one question.
    const x = link('X', '[[Mara Quill]]', '[[2026-10-16 Platform Standup#^t0001]]');
    const y = link('Y', '[[Mara Quill (Larkspur)]]', '[[2026-10-16 Platform Standup#^t0002]]');
    const z = link('Z', '[[Tobias Fenn]]', '[[2026-10-16 Platform Standup]]');
    expect(groupSets([x, y, z])).toEqual(groupSets([z, x, y]));
  });

  it('never offers Accept-all a proposal that conflicts with one waiting in a group', () => {
    const x = link('X', '[[Mara Quill]]', '[[2026-10-16 Platform Standup#^t0001]]');
    const y = link('Y', '[[Mara Quill (Larkspur)]]', '[[2026-10-16 Platform Standup#^t0002]]');
    const z = link('Z', '[[Tobias Fenn]]', '[[2026-10-16 Platform Standup]]');
    // Y conflicts with Z (Z cites the note alone), yet Y is listed alone and accepted at once.
    expect(acceptableAtOnce(proposalEntries([x, y, z]))).not.toContain(y.path);
  });

  it('never has "Accept all high confidence" take two links that disagree, when a duplicate hides the conflict', () => {
    // Seed 1507, shrunk: the note-level Larkspur joins the t0002 gathering as a duplicate,
    // so no group forms anywhere, and Tobias (t0001) stands alone beside it.
    const larkspur = link(
      'L1',
      '[[Mara Quill (Larkspur)]]',
      '[[2026-10-16 Platform Standup#^t0002]]',
    );
    const tobias = link('T', '[[Tobias Fenn]]', '[[2026-10-16 Platform Standup#^t0001]]');
    const larkspurNote = link('L2', '[[Mara Quill (Larkspur)]]', '[[2026-10-16 Platform Standup]]');
    const taken = acceptableAtOnce(proposalEntries([larkspur, tobias, larkspurNote]));
    expect(taken.includes(tobias.path) && taken.includes(larkspurNote.path)).toBe(false);
  });

  it('shows two proposals of the very same link once, not as two rows', () => {
    const one = link('Mara 1', '[[Mara Quill]]', '[[2026-10-16 Platform Standup#^t0002]]');
    const two = link('Mara 2', '[[Mara Quill]]', '[[2026-10-16 Platform Standup#^t0002]]');
    expect(proposalEntries([one, two])).toHaveLength(1);
  });

  it('never has "Accept all high confidence" apply one link twice', () => {
    const one = link('Mara 1', '[[Mara Quill]]', '[[2026-10-16 Platform Standup#^t0002]]');
    const two = link('Mara 2', '[[Mara Quill]]', '[[2026-10-16 Platform Standup#^t0002]]');
    expect(acceptableAtOnce(proposalEntries([one, two]))).toHaveLength(1);
  });

  it('treats links to the same note, written differently, as one value — not a pick-one question', () => {
    const plain = link('Mara 1', '[[Mara Quill]]', '[[2026-10-16 Platform Standup#^t0002]]');
    const aliased = link('Mara 2', '[[Mara Quill|Mara]]', '[[2026-10-16 Platform Standup#^t0002]]');
    const cased = link('Mara 3', '[[mara quill]]', '[[2026-10-16 Platform Standup#^t0002]]');
    expect(conflictGroups([plain, aliased, cased])).toEqual([]);
  });

  it('does not ask "pick one" between two people one line names into a many-valued relation', () => {
    // "Mara Quill and Tobias Fenn will pair on it" — one block, two attendees, both right.
    const mara = link('Mara', '[[Mara Quill]]', '[[2026-10-16 Platform Standup#^t0004]]');
    const tobias = link('Tobias', '[[Tobias Fenn]]', '[[2026-10-16 Platform Standup#^t0004]]');
    // The relation's type says it holds many: the domain is told, it does not look.
    const manyValued = (slot: { property: string }) => slot.property === 'people';
    expect(conflictGroups([mara, tobias], { manyValued })).toEqual([]);
    expect(proposalEntries([mara, tobias], { manyValued })).toHaveLength(2);
  });
});
