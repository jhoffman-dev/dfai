import { foldedLinkName } from '../markdown/resolve-wikilink.ts';
import { readWikiLink } from '../markdown/wikilink-spans.ts';
import type { VaultPath } from '../vault/vault-path.ts';
import {
  isNoteProposal,
  PROPOSAL_CONFIDENCES,
  type ProposalConfidence,
  type ProposalKind,
  type ProposalNote,
} from './proposal.ts';

/** The relation of a note a proposal would fill: what two proposals must aim at to conflict. */
export interface ProposalSlot {
  readonly note: VaultPath;
  readonly property: string;
}

/** One value a conflict group offers, with every proposal that proposes it: the first is the one accepted. */
export interface ConflictChoice {
  readonly value: string;
  readonly proposals: readonly ProposalNote[];
}

/**
 * Proposals that cannot all be accepted (#307, Q12): the same kind, the same
 * source and the same slot, but different values — three links for one
 * mention in one meeting, say. One is picked; the others are rejected.
 */
export interface ConflictGroup {
  readonly kind: ProposalKind;
  readonly slot: ProposalSlot;
  /** As the first member cites it; null when none cites a source. */
  readonly source: string | null;
  /** In the order the proposals came: two or more for a conflict, one when the same proposal was made more than once. */
  readonly choices: readonly ConflictChoice[];
  /** As sure as the least sure member; null when none says. */
  readonly confidence: ProposalConfidence | null;
}

/** What the Proposals section lists: a proposal on its own, or a choice between several. */
export type ProposalEntry = { readonly one: ProposalNote } | { readonly choice: ConflictGroup };

/** The relation a proposal fills, or null when it fills none — then it conflicts with nothing. */
export function proposalSlotOf(proposal: ProposalNote): ProposalSlot | null {
  if (proposal.kind === 'link') {
    return { note: proposal.payload.note, property: proposal.payload.property };
  }
  if (!isNoteProposal(proposal)) return null;
  const { linkFrom } = proposal.payload;
  return linkFrom === null ? null : { note: linkFrom.note, property: linkFrom.property };
}

/** What a proposal proposes for its slot: the link it adds, or the title of the note it makes. */
export function proposalValueOf(proposal: ProposalNote): string {
  return proposal.kind === 'link' ? proposal.payload.link.trim() : proposal.payload.title.trim();
}

/** A source as compared: its note, lower-cased, and the block it names, if any. */
interface SourceKey {
  readonly note: string;
  readonly block: string | null;
}

function sourceKeyOf(source: string | null): SourceKey {
  if (source === null) return { note: '', block: null };
  const link = readWikiLink(source.trim());
  if (link === null) return { note: source.trim().toLowerCase(), block: null };
  return {
    note: link.target.trim().toLowerCase(),
    block: link.heading?.trim().toLowerCase() ?? null,
  };
}

/**
 * Whether two sources are the same: the same note, and the same block when
 * both name one. A proposal citing the note alone sits with those citing
 * its blocks.
 */
function sameSource(a: SourceKey, b: SourceKey): boolean {
  if (a.note !== b.note) return false;
  return a.block === null || b.block === null || a.block === b.block;
}

/** What a proposal proposes as slots compare it: the note a link opens, ignoring its alias and case. */
export function proposalValueKey(proposal: ProposalNote): string {
  const value = proposalValueOf(proposal);
  const link = readWikiLink(value);
  return foldedLinkName(link === null ? value : link.target);
}

/** Whether a relation holds many notes, so its proposals are all welcome rather than a pick-one. */
export type ManyValued = (slot: ProposalSlot) => boolean;

export interface GroupingOptions {
  /** Which slots hold several values; none does unless this says so. */
  readonly manyValued?: ManyValued;
}

/** The proposals that fill one slot, as one entry: every value proposed and each proposal of it. */
interface Component {
  readonly kind: ProposalKind;
  readonly slot: ProposalSlot;
  /** In the order the proposals came. */
  readonly members: readonly ProposalNote[];
}

interface Candidate {
  readonly proposal: ProposalNote;
  readonly slot: ProposalSlot;
  readonly source: SourceKey;
  readonly value: string;
}

/**
 * Whether two proposals belong together: the same kind and slot, sources that
 * overlap, and — for a slot holding one value — any value, since different
 * ones are a conflict and equal ones a duplicate; for a many-valued slot,
 * only the same value, which is a duplicate.
 */
function related(a: Candidate, b: Candidate, many: ManyValued): boolean {
  if (a.proposal.kind !== b.proposal.kind) return false;
  if (a.slot.note !== b.slot.note || a.slot.property !== b.slot.property) return false;
  if (!sameSource(a.source, b.source)) return false;
  return a.value === b.value || !many(a.slot);
}

/**
 * The connected components of "related": "same source" is not transitive (a
 * note-level citation sits with every block, two blocks do not sit together),
 * so the groups are closed under it with union-find, and come out the same
 * whatever order the proposals arrive in.
 */
function components(open: readonly ProposalNote[], many: ManyValued): readonly Component[] {
  const candidates = open.flatMap((proposal): Candidate[] => {
    const slot = proposalSlotOf(proposal);
    if (slot === null) return [];
    return [
      { proposal, slot, source: sourceKeyOf(proposal.source), value: proposalValueKey(proposal) },
    ];
  });
  const root = candidates.map((_, at) => at);
  const find = (at: number): number => {
    let top = at;
    while (root[top] !== top) top = root[top] as number;
    root[at] = top;
    return top;
  };
  candidates.forEach((each, at) => {
    for (let before = 0; before < at; before += 1) {
      if (related(candidates[before] as Candidate, each, many)) root[find(before)] = find(at);
    }
  });
  const byRoot = new Map<number, Candidate[]>();
  candidates.forEach((each, at) => {
    const held = byRoot.get(find(at));
    if (held === undefined) byRoot.set(find(at), [each]);
    else held.push(each);
  });
  // Map order is the order roots were first met, not first members: sort by the first member's place.
  return [...byRoot.values()]
    .map((members) => ({
      kind: (members[0] as Candidate).proposal.kind,
      slot: (members[0] as Candidate).slot,
      members: members.map((each) => each.proposal),
    }))
    .sort(
      (a, b) =>
        open.indexOf(a.members[0] as ProposalNote) - open.indexOf(b.members[0] as ProposalNote),
    );
}

/** The proposals of one slot by value, each value once, in the order first proposed. */
function choicesOf(members: readonly ProposalNote[]): readonly ConflictChoice[] {
  const byValue = new Map<string, ProposalNote[]>();
  for (const proposal of members) {
    const key = proposalValueKey(proposal);
    const held = byValue.get(key);
    if (held === undefined) byValue.set(key, [proposal]);
    else held.push(proposal);
  }
  return [...byValue.values()].map((proposals) => ({
    value: proposalValueOf(proposals[0] as ProposalNote),
    proposals,
  }));
}

/** The least sure of the confidences given; null when none is. */
function leastConfidence(members: readonly ProposalNote[]): ProposalConfidence | null {
  const said = members.flatMap((each) => (each.confidence === null ? [] : [each.confidence]));
  if (said.length === 0) return null;
  // PROPOSAL_CONFIDENCES runs high → low: the last one found is the least sure.
  return [...PROPOSAL_CONFIDENCES].reverse().find((each) => said.includes(each)) ?? null;
}

function groupOf(component: Component): ConflictGroup {
  return {
    kind: component.kind,
    slot: component.slot,
    source: component.members[0]?.source ?? null,
    choices: choicesOf(component.members),
    confidence: leastConfidence(component.members),
  };
}

const NO_MANY: ManyValued = () => false;

/**
 * The open proposals that conflict, each group one "pick one" question, in
 * the order their first members came. Computed afresh from what is open:
 * nothing about a group is persisted.
 */
export function conflictGroups(
  open: readonly ProposalNote[],
  { manyValued = NO_MANY }: GroupingOptions = {},
): readonly ConflictGroup[] {
  return components(open, manyValued)
    .map(groupOf)
    .filter((group) => group.choices.length >= 2);
}

/**
 * The open proposals as the section lists them: each on its own, except
 * those that belong together, which stand as one entry where the first of
 * them was. A conflict has several choices; the same proposal made more than
 * once is one choice held by each of them, listed once.
 */
export function proposalEntries(
  open: readonly ProposalNote[],
  options: GroupingOptions = {},
): readonly ProposalEntry[] {
  const placed = new Map<VaultPath, ConflictGroup>();
  for (const component of components(open, options.manyValued ?? NO_MANY)) {
    if (component.members.length < 2) continue;
    const group = groupOf(component);
    for (const member of component.members) placed.set(member.path, group);
  }
  const shown = new Set<ConflictGroup>();
  return open.flatMap((proposal): ProposalEntry[] => {
    const group = placed.get(proposal.path);
    if (group === undefined) return [{ one: proposal }];
    if (shown.has(group)) return [];
    shown.add(group);
    return [{ choice: group }];
  });
}

/** Whether an entry asks the person to pick between different values. */
export function isPickOne(entry: ProposalEntry): boolean {
  return 'choice' in entry && entry.choice.choices.length > 1;
}

/**
 * The proposals "Accept all high confidence" accepts: the sure ones that need
 * no choice — a proposal on its own, or the first of those that are one and
 * the same, so a link is never applied twice. Their duplicates are rejected
 * behind them (`duplicatesOf`).
 */
export function acceptableAtOnce(entries: readonly ProposalEntry[]): readonly VaultPath[] {
  return entries.flatMap((entry) => {
    if ('one' in entry) return entry.one.confidence === 'high' ? [entry.one.path] : [];
    const [only] = entry.choice.choices;
    const first = only?.proposals[0];
    if (isPickOne(entry) || first === undefined || entry.choice.confidence !== 'high') return [];
    return [first.path];
  });
}

/** The proposals that are the very same as `path`, which accepting it makes redundant; none for a proposal on its own. */
export function duplicatesOf(
  entries: readonly ProposalEntry[],
  path: VaultPath,
): readonly VaultPath[] {
  for (const entry of entries) {
    if (!('choice' in entry) || isPickOne(entry)) continue;
    const proposals = entry.choice.choices[0]?.proposals ?? [];
    if (proposals[0]?.path === path) return proposals.slice(1).map((each) => each.path);
  }
  return [];
}
