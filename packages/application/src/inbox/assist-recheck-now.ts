import {
  assistRecheck,
  foldedPersonName,
  noteTitle,
  type AssistEvidence,
  type AssistNoteNow,
  type AssistRecheck,
  type AssistRow,
  type VaultPath,
} from '@dfai/domain';
import type { ArchivePorts } from '../archive/archive-notes.ts';
import type { Clock } from '../ports.ts';
import { assistPropertiesOf, readAssistVault, titlesTaken } from './assist-facts.ts';

/** What re-checking a row reads through: the vault, its panes, and the clock. */
export interface RecheckPorts extends ArchivePorts {
  readonly clock: Pick<Clock, 'now' | 'today'>;
}

/** A row re-checked, with the item as it was read for it: what its writes are held to. */
export type RecheckedNow =
  | Extract<AssistRecheck, { kind: 'ask' }>
  | (Extract<AssistRecheck, { kind: 'apply' }> & { readonly text: string; readonly modified: number });

/**
 * Reads again everything a row rests on — the item, a duplicate's kept task,
 * the vault's projects, people and open tasks, and the titles a new person
 * would take — and asks the domain whether it may still be applied (#909).
 * Nothing here writes. A note that cannot be read counts as gone.
 */
export async function recheckNow(
  ports: RecheckPorts,
  { row, evidence, notePaths }: { row: AssistRow; evidence: AssistEvidence; notePaths: readonly VaultPath[] },
): Promise<RecheckedNow> {
  const item = await noteNow(ports, evidence.item.path);
  const read = await readAssistVault(ports, { notes: [], items: [] });
  const kept = row.step.kind === 'duplicate' ? await noteNow(ports, row.step.of.path) : null;
  const keptPath = row.step.kind === 'duplicate' ? row.step.of.path : null;
  const adding = row.people.flatMap((each) => (each.kind === 'add' ? [each.name] : []));
  const checked = assistRecheck({
    row,
    evidence,
    item,
    kept: kept === null ? null : { ...kept, task: read.tasks.find((task) => task.path === keptPath) ?? null },
    vault: { ...read.facts, takenTitles: await takenNow(ports, adding, notePaths) },
    tasks: read.tasks,
    cut: read.cut,
    now: ports.clock.now(),
  });
  if (checked.kind === 'ask') return checked;
  return { ...checked, text: item!.text, modified: item!.modified };
}

async function noteNow(ports: ArchivePorts, path: VaultPath): Promise<AssistNoteNow | null> {
  // A note that cannot be read is no note to apply anything to: the row asks.
  const read = await ports.fs.readTextFile(path).catch(() => null);
  if (read === null) return null;
  return {
    text: read.text,
    modified: read.modified,
    unsaved: ports.editors.state(path) === 'dirty',
    properties: assistPropertiesOf(ports.markdown, read.text),
  };
}

/**
 * The new people's names a note has as its title now: as the index has them,
 * and as the tree does — a note made a moment ago is in the tree before the
 * index has it.
 */
async function takenNow(
  ports: ArchivePorts,
  names: readonly string[],
  notePaths: readonly VaultPath[],
): Promise<ReadonlySet<string>> {
  if (names.length === 0) return new Set();
  const indexed = await titlesTaken(ports, names);
  const inTree = new Set(notePaths.map((path) => foldedPersonName(noteTitle(path))));
  const folded = names.map(foldedPersonName);
  return new Set([...indexed, ...folded.filter((name) => inTree.has(name))]);
}
