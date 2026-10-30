import {
  AFTER_A_MEETING_PROMPT,
  meetingSetupPlan,
  meetingSetupWithin,
  selfEmailsFromText,
  type AutomationDraft,
  type MeetingSetupFacts,
  type MeetingSetupPlan,
  type ObjectType,
} from '@dfai/domain';
import type { MarkdownPort } from '../notes/ports.ts';
import type { Clock } from '../ports.ts';
import { loadSelfEmails, saveSelfEmails } from '../profile/self-emails-setting.ts';
import type { SettingsWriter } from '../settings/index.ts';
import { saveObjectType } from '../types/edit-types.ts';
import { loadObjectTypes, type DefinedType } from '../types/load-types.ts';
import type { VaultFsPort } from '../vault/ports.ts';
import { listVaultNotes } from '../vault/read-vault.ts';
import { loadAutomations } from './load-automations.ts';
import { createAutomation, ensureShippedPrompt } from './save-automation.ts';

/** What the setup of meeting post-processing would write, as the preview showed it (#191). */
export type MeetingSetupOffer = MeetingSetupPlan<DefinedType>;

interface ReadPorts {
  readonly fs: VaultFsPort;
  readonly markdown: MarkdownPort;
}

export interface MeetingSetupPorts extends ReadPorts {
  readonly clock: Pick<Clock, 'now' | 'localNow'>;
  /** The vault's settings note's writer, shared with every other setting kept there. */
  readonly settings: SettingsWriter;
}

/** One thing the yes could not write, and why; the rest were written. */
export interface MeetingSetupFailure {
  readonly what: string;
  readonly reason: string;
}

/** What the yes did. */
export interface MeetingSetupDone {
  /** Each thing written, in a sentence. */
  readonly written: readonly string[];
  readonly failed: readonly MeetingSetupFailure[];
  /** Why nothing at all was written: the addresses typed are not all addresses. */
  readonly refused: string | null;
  /** Whether a rule that post-processes meetings is on now: there and on before, or just written. */
  readonly ruleOn: boolean;
}

/**
 * What one yes would write to set up meeting post-processing (#191,
 * ADR-0036), read from the vault as it is now: its rules, its types, the
 * prompt's path and the owner's addresses. It reads only; nothing is written
 * until {@link acceptMeetingSetup}.
 */
export async function previewMeetingSetup(ports: ReadPorts): Promise<MeetingSetupOffer> {
  return meetingSetupPlan(await setupFacts(ports));
}

async function setupFacts(ports: ReadPorts): Promise<MeetingSetupFacts<DefinedType>> {
  const takenPaths = await listVaultNotes(ports);
  const [types, listing, [prompt], selfEmails] = await Promise.all([
    loadObjectTypes(ports),
    loadAutomations({ ...ports, notePaths: takenPaths }),
    ports.fs.readNotes([AFTER_A_MEETING_PROMPT]),
    loadSelfEmails(ports),
  ]);
  return {
    types,
    rules: listing.automations.map(({ rule }) => rule),
    takenPaths,
    promptHeld: prompt !== undefined,
    selfEmails,
  };
}

/**
 * Does what the preview listed, once the person said yes: the types' keys
 * first, then the prompt and the owner's addresses, and the rule last, so
 * that whatever of the rest could be written is in place before the rule
 * hears its first meeting. What to write is worked
 * out again from the vault as it is now and kept within what was shown
 * ({@link meetingSetupWithin}): anything already there is skipped, so a
 * second yes writes nothing twice. Addresses that do not read as addresses
 * refuse the whole yes before anything is written. One part failing does not
 * stop the others; each failure is said.
 */
export async function acceptMeetingSetup({
  offer,
  emails,
  ...ports
}: MeetingSetupPorts & {
  offer: MeetingSetupPlan<ObjectType>;
  /** What was typed in the preview's address field; empty saves none. */
  emails: string;
}): Promise<MeetingSetupDone> {
  const typed = offer.asksEmails ? selfEmailsFromText(emails) : { ok: true as const, emails: [] };
  if (!typed.ok) return { written: [], failed: [], refused: typed.problem, ruleOn: offer.ruleOn };
  const now = meetingSetupWithin(offer, meetingSetupPlan(await setupFacts(ports)));
  const done: SetupSteps = { written: [], failed: [] };
  for (const { before, after, added } of now.extensions) {
    const keys = added.map((property) => property.key).join(', ');
    await step(done, {
      what: `The ${before.label} type`,
      said: `The ${before.label} type gained ${keys}.`,
      write: () => saveObjectType({ ...ports, path: before.path, before, type: after }),
    });
  }
  const { prompt, rule } = now;
  if (prompt !== null) {
    await step(done, {
      what: `The prompt ${prompt}`,
      said: `Wrote the prompt ${prompt}.`,
      write: () => ensureShippedPrompt(ports.fs, prompt),
    });
  }
  if (now.asksEmails && typed.emails.length > 0) {
    await step(done, {
      what: 'Your email addresses',
      said: `Saved your emails: ${typed.emails.join(', ')}.`,
      write: () => saveSelfEmails({ settings: ports.settings, emails: typed.emails }),
    });
  }
  const ruleWritten = rule !== null && (await writeRule(ports, done, rule));
  return { ...done, refused: null, ruleOn: now.ruleOn || ruleWritten };
}

/**
 * Writes the rule, and says so; whether it was written. Writing a rule writes
 * the prompt DFAI ships for it where no note is (`createAutomation`), so a
 * prompt that went missing after the preview is written with it, and said too.
 */
async function writeRule(
  ports: MeetingSetupPorts,
  done: SetupSteps,
  rule: AutomationDraft,
): Promise<boolean> {
  const prompt = rule.action.kind === 'claude' ? rule.action.prompt : null;
  const held = async () => prompt !== null && (await ports.fs.readNotes([prompt])).length > 0;
  const promptMissing = prompt !== null && !(await held());
  const ok = await step(done, {
    what: `The “${rule.name}” rule`,
    said: `Turned on “${rule.name}”.`,
    write: async () => {
      await createAutomation({ ...ports, draft: rule, takenPaths: await listVaultNotes(ports) });
    },
  });
  if (ok && promptMissing && (await held())) {
    done.written.push(`Wrote the prompt ${prompt}, which the “${rule.name}” rule names.`);
  }
  return ok;
}

interface SetupSteps {
  readonly written: string[];
  readonly failed: MeetingSetupFailure[];
}

/** Runs one part of the yes, saying it was written or why it was not. */
async function step(
  done: SetupSteps,
  { what, said, write }: { what: string; said: string; write: () => Promise<void> },
): Promise<boolean> {
  try {
    await write();
    done.written.push(said);
    return true;
  } catch (cause) {
    done.failed.push({ what, reason: cause instanceof Error ? cause.message : String(cause) });
    return false;
  }
}
