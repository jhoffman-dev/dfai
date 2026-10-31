/**
 * Automations, read-only: `/v1/automations/...`. Running, undoing, and making
 * or editing a rule stay in the app — rules and logs live in `.atlas`, which
 * the API never writes, and a run changes many notes at once (ADR-0016).
 */

import { z } from 'zod';
import { defineTool, definedOnly } from './define.ts';
import { limit, noInput } from './inputs.ts';

const READ_ONLY = { readOnlyHint: true } as const;

const id = z
  .string()
  .min(1)
  .describe('The automation\'s "id", exactly as atlas_automations listed it.');

const IN_THE_APP =
  'Running a rule, undoing its last run, and making, editing or turning one on or off are done ' +
  'in DFAI, on the Automations page, not through these tools.';

export const automations = defineTool({
  name: 'atlas_automations',
  title: 'List automations',
  description:
    'Every automation in the vault — a rule that archives notes, sets properties on them, or asks ' +
    'Claude about them, on a schedule or when a note of a type is created or changed — as the ' +
    'Automations page lists it: { automations: [{ id, name, path, enabled, when, note, which, ' +
    'olderThanDays, do, set, claude, schedule, action, lastRun, nextRun, timeZone, paused }], broken: [{ ' +
    'path, name, problem }] }. "when" ' +
    'is as the rule\'s file writes it ("daily at 03:00", "fridays at 15:00", "a meeting is created or changed"); ' +
    '"note" is { type, on: ["created" and/or "changed"] } for a rule a note sets off, which runs ' +
    'once per version of each note of that type its query matches, or null. "which" is the ' +
    'DFAI query naming its notes; "do" is "archive", "set" or "claude", with "set" the values ' +
    'it writes, and "claude" { prompt, skill, tools, output, folder, data }: the prompt note — or, ' +
    'for a step that names a skill, "skill" (its name, else null) with its SKILL.md as "prompt" — the read tools ' +
    'Claude may call, and what it writes — "proposals" or "meeting-items" (a meeting\'s action ' +
    'items, decisions, follow-ups and suggested glossary terms, each citing a transcript turn) waiting in the Inbox, or ' +
    '"note", one new note in "folder"; "data" is "weekly-review" for a step handed the weekly review, ' +
    'or "meeting-briefs" for the morning brief, one note per meeting of the day in "folder"/<day>, ' +
    'whose note is written once a period and keeps only list items linking a note it was given, ' +
    'or null. A Claude step never edits a note. ' +
    '"lastRun" is { at, kind, trigger, summary } or null, "trigger" "note" for a run a note set ' +
    'off; "nextRun" is a local time or null, on the Mac\'s clock unless "timeZone" names another: ' +
    'the morning brief keeps its calendar\'s clock, and "timeZone" is that zone (IANA) once a sync ' +
    'has learned it, else null; "paused" says why the app is holding it back. A ' +
    `rule under "broken" cannot be read and never runs. ${IN_THE_APP}`,
  inputSchema: noInput,
  annotations: READ_ONLY,
  call: (client) => client.automations(),
});

export const automationLog = defineTool({
  name: 'atlas_automation_log',
  title: "Read an automation's log",
  description:
    "An automation's log, newest first: { automation: { id, name }, entries: [{ kind, at, " +
    'heading, summary, trigger?, of?, problem?, capped?, count?, done, left, versions?, went?, ' +
    'claude? }], ' +
    'truncated }. "versions" lists, on a run of a rule a note sets off, each note version ' +
    '{ path, digest, wrote } it handled, or its own write left; none of them sets it off again. ' +
    '"went" lists paths a note it had handled left — deleted, moved, renamed, archived or ' +
    'replaced: a new note there is new to it. "kind" is ' +
    '"run", "undo", "failed" (its query did not read, or its Claude step failed), "turnedOn", ' +
    '"seen" or "letGo" (held back, it heard more syncs\' news than it keeps and let "count" of ' +
    'them go; a run by hand takes the notes they named). "done" lists each note it moved ({ kind: "archived", from, to }), each property it ' +
    'set, with its value before and after, or each note a Claude step made ({ kind: "proposed" ' +
    'or "created", path }); "left" lists notes it matched and left alone, with why. "claude" is ' +
    '{ model, ms }: the model a Claude step asked and how long it took — with "cut", ' +
    '[{ path, shown, of }], when a note was too long to show it whole: the characters it read, ' +
    'of how many; "asks", how many times the model was asked (what the hourly cap counts); ' +
    '"alreadyMade", how many proposals it answered with were made before and so not made again; ' +
    '"dropped" and "adjusted", [{ title, reason }], for each item of an answer it left out, or ' +
    'kept with a fault put right (a due date that was no date); and "warnings", what to know of the run. ' +
    'An unknown id is "not_found"; a rule that cannot be read is "invalid".',
  inputSchema: z.object({
    id,
    limit: limit.max(100).optional().describe('At most this many entries, 1 to 100. Default 20.'),
  }),
  annotations: READ_ONLY,
  call: (client, { id: ruleId, ...query }) => client.automationLog(ruleId, definedOnly(query)),
});

export const automationDryRun = defineTool({
  name: 'atlas_automation_dry_run',
  title: 'Dry-run an automation',
  description:
    "What an automation would do if it ran now, found as the app's Dry run finds it and with " +
    'nothing written — for a rule a note sets off, the notes its query matches that it has not ' +
    'handled as they are now: { automation: { id, name }, plan: { do, set, claude, summary, notes: ' +
    '[{ path, title }], passedOver: [{ path, reason }], passedOverMore, capped, cap } }. "notes" ' +
    'are the notes it would archive, set "set" on — a note that already holds those values is ' +
    'left out — or ask Claude about, with the prompt, skill and tools under "claude"; Claude is not ' +
    'asked. "capped" is ' +
    'true when more matched than one run may do ("cap"). "passedOver" lists at most 500 notes it ' +
    'would leave alone; "passedOverMore" counts the rest. For the "After a meeting" step only, ' +
    '"notLinked": { meetings: [{ path, title }], capped } names meetings whose linking failed, ' +
    'which Run now links again first; left out when there are none. A rule whose query does not read is ' +
    `"query_failed", with why. ${IN_THE_APP}`,
  inputSchema: z.object({ id }),
  annotations: READ_ONLY,
  call: (client, { id: ruleId }) => client.automationDryRun(ruleId),
});

export const automationTools = [automations, automationLog, automationDryRun];
