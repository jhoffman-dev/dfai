/** Tools that create notes the way DFAI's own shortcuts do: the daily note, quick capture. */

import { z } from 'zod';
import { defineTool, definedOnly } from './define.ts';
import { noInput } from './inputs.ts';
import { TASK_STATUSES_DESCRIBED } from './task-statuses.ts';

export const dailyNote = defineTool({
  name: 'atlas_daily_note',
  title: "Today's daily note",
  description:
    "Get today's daily note, creating it from its template if it does not exist yet. Returns " +
    '{ note, created }. Made without a Daily template in a vault whose Task type is on GTD, it ' +
    'starts with live atlas-query blocks ' +
    "for the day's due and overdue tasks and its next actions; run a block's query with " +
    'atlas_query to read its rows. To add to it, pass its path and "modified" to atlas_append_to_note.',
  inputSchema: noInput,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  call: (client) => client.daily(),
});

export const captureTask = defineTool({
  name: 'atlas_capture_task',
  title: 'Capture a task',
  description:
    "Capture a task exactly as DFAI's quick capture does: a new Task note named by the text, " +
    'from the Task template when there is one, waiting in Inbox/ (numbered if the name is ' +
    'taken), with status "inbox" when the vault\'s Task type has it. Returns the created note. ' +
    'To set more properties, follow up with atlas_update_properties on its path; to file it ' +
    'under a project or an area, atlas_process_inbox_item. ' +
    TASK_STATUSES_DESCRIBED,
  inputSchema: z.object({
    text: z
      .string()
      .min(1)
      .describe('The task, as someone would type it, e.g. "Call Sam about the lease".'),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  call: (client, { text }) => client.capture({ text }),
});

export const quickAddTypes = defineTool({
  name: 'atlas_quick_add_types',
  title: "The add button's types",
  description:
    "List the types DFAI's floating add button offers, as the person chose them in Settings, " +
    'and the property keys it asks for beside the name. Returns { types: [{ name, label, fields }] }. ' +
    'Pass one to atlas_quick_add.',
  inputSchema: noInput,
  annotations: { readOnlyHint: true },
  call: (client) => client.quickAddTypes(),
});

export const quickAdd = defineTool({
  name: 'atlas_quick_add',
  title: 'Quick-add a note of a type',
  description:
    "Add a note of a type exactly as DFAI's add button does: from the type's template when there " +
    'is one, with "values" written as each property\'s kind stores them (a number as a number, a ' +
    'comma list for a multi-select), in the folder the button uses, numbered if the name is taken. ' +
    'Any type from atlas_list_types works; atlas_quick_add_types lists the ones the button offers ' +
    'and the fields it asks for. Returns the created note.',
  inputSchema: z.object({
    type: z.string().min(1).describe('The type\'s name, e.g. "task".'),
    name: z.string().min(1).describe('The new note\'s name, e.g. "Call Sam".'),
    values: z
      .record(z.string(), z.string())
      .optional()
      .describe('Property values as text by key, e.g. { "status": "doing", "due": "2026-10-01" }.'),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  call: (client, input) => client.quickAdd(definedOnly(input)),
});

export const captureTools = [dailyNote, captureTask, quickAddTypes, quickAdd];
