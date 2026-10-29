/**
 * The weekly review and the Today page: `GET /v1/review/weekly` (P30-07),
 * `GET /v1/today` (#111), and choosing a task for today, `POST /v1/today/choose` (#108), and ticking a task done, `POST /v1/tasks/done` (#107).
 */

import { z } from 'zod';
import { defineTool } from './define.ts';
import { noInput, notePath } from './inputs.ts';

export const weeklyReview = defineTool({
  name: 'atlas_weekly_review',
  title: 'Weekly review',
  description:
    "GTD's weekly review, as DFAI's Weekly review page shows it, read on the app's clock: " +
    '{ review: { today, staleWaiting, projectsWithoutNextAction, overdue, untouchedSomeday, ' +
    'inbox: { count, toFile, toAnswer, more }, truncated } }. inbox counts the one Inbox as ' +
    'the sidebar does: notes to file plus proposals to answer. ' +
    'staleWaiting: tasks Waiting and untouched for more ' +
    'than 7 days, with "waitingOn" (who, link or plain name). projectsWithoutNextAction: ' +
    'projects with status active and no task filed under them (by "project") that is ' +
    'next-action or in-progress. overdue: open tasks (inbox, backlog, next-action, ' +
    'in-progress, waiting) due before today. untouchedSomeday: someday and longterm tasks ' +
    'untouched for more than 30 days. A task is { path, title, status, due, defer, recurrence, ' +
    'waitingOn, contexts, project, projectTitle, modified } ("recurrence" how it repeats, null ' +
    'when it does not), a project { path, title, status, moving }. "Untouched" is the ' +
    'file\'s last change; a task deferred past today is in no section until its "defer" day. ' +
    '"truncated" means tasks were held back, so a task section may be missing some. To act on ' +
    'an item as the page does: set its status or "defer" with atlas_update_properties (a late ' +
    'task leaves overdue only for someday, longterm, a later defer, or archive), or archive a ' +
    'project with atlas_archive. Setting status archive finishes a task and, for a repeating ' +
    'one (with "recurrence"), ends its series; the page instead rolls a repeating task on to ' +
    'its next due date at next-action.',
  inputSchema: noInput,
  annotations: { readOnlyHint: true },
  call: (client) => client.weeklyReview(),
});

export const today = defineTool({
  name: 'atlas_today',
  title: 'Today',
  description:
    "What needs the person today, as DFAI's Today page shows it, read on the app's clock: " +
    '{ today: { today, sections, stalledProjects, inbox: { count, toFile, toAnswer, more }, ' +
    'truncated } }. sections are always these eight, in order, each { id, count, groups }: ' +
    'chosen (open tasks chosen for today: "focus" is today, any status), carriedOver (open ' +
    'tasks chosen on an earlier day, to keep for today or drop), ' +
    'overdue (open tasks due before today), dueToday, backToday (tasks whose "defer" is ' +
    'today, any open status, and inbox, backlog, someday or longterm tasks whose "defer" ' +
    'day has passed), inProgress, nextActions (grouped by project, those under none ' +
    'last), waiting (grouped by who is waited on). A task is in one section only, the first ' +
    'that claims it, and a task deferred past today is in none. A group is { key, label, ' +
    'project, tasks }; a task is { path, title, status, due, defer, recurrence, waitingOn, ' +
    'contexts, project, projectTitle, modified, waitingDays, focus } ("recurrence" how it ' +
    'repeats, null when it does not; "focus" the day it was chosen for, or null). waitingDays, for a waiting task, is whole ' +
    "days since the file's last change, not since it began waiting: any edit restarts it. " +
    'stalledProjects counts active projects with no next-action or in-progress task (listed ' +
    'by atlas_weekly_review). To act on a task as the page does, use atlas_update_properties: ' +
    'set "status", or set "defer" to a later day (YYYY-MM-DD) to take it off the page until ' +
    'then. Status waiting never needs "waiting_on"; set it too only to say who. Setting status ' +
    'archive finishes a task and, for a repeating one (with "recurrence"), ends its series; ' +
    "the page's tick instead rolls a repeating task on to its next due date. To choose a task " +
    'for today, or keep or drop one carried over, use atlas_choose_for_today.',
  inputSchema: noInput,
  annotations: { readOnlyHint: true },
  call: (client) => client.today(),
});

export const chooseForToday = defineTool({
  name: 'atlas_choose_for_today',
  title: 'Choose a task for today',
  description:
    "Choose a task for today, or take it off, as the Today page's Today button does: " +
    '"chosen": true sets its "focus" to today on the app\'s clock, so it heads the page under ' +
    'chosen, and keeps one listed under carriedOver; false takes "focus" out, which also drops ' +
    'one carried over. A choice is of its day: tomorrow it is listed under carriedOver until ' +
    'kept or dropped. Returns the task note. "path" must be a note of type task. Refused as ' +
    'invalid, writing nothing, where atlas_today says "choosing": false (the Task type keeps ' +
    'no "focus" date), and for a task whose "focus" is not one day ("focusIsOwn"). Finishing ' +
    'a task takes its "focus" out.',
  inputSchema: z.object({
    path: notePath.describe('The task, by its path, e.g. "Tasks/Call the printer.md".'),
    chosen: z.boolean().describe('True to choose it for today; false to take it off today.'),
  }),
  // Setting the same day, or taking out a key that is gone, twice changes nothing more.
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  call: (client, input) => client.chooseForToday(input),
});

export const tickTask = defineTool({
  name: 'atlas_tick_task',
  title: 'Tick a task done',
  description:
    'Tick a task done, or untick it, as its done box does on the Today page and in a GTD view: ' +
    '"done": true finishes it — status archive with "completed" today on the app\'s clock — ' +
    'and a repeating one (with "recurrence") rolls on to its next "due" and back to next-action ' +
    'instead; either way a "focus" of one day is taken out. "done": false takes a finished task ' +
    'back to next-action, and leaves open work as it is. Ticking needs "ifModified", the ' +
    'task\'s "modified" as read: a tick sent twice would roll a repeating task on twice, so ' +
    'the second is refused as conflict. To set any other status, use atlas_update_properties. ' +
    'Returns the task note. "path" must be a note of type task.',
  inputSchema: z.object({
    path: notePath.describe('The task, by its path, e.g. "Tasks/Call the printer.md".'),
    done: z.boolean().describe('True to tick it done; false to untick a finished one.'),
    ifModified: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('The task\'s "modified" as read; required when "done" is true.'),
  }),
  // A tick rolls a repeating task on, so the same call twice is not the same as once.
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  call: (client, input) => client.tickTask(input),
});

export const reviewTools = [weeklyReview, today, chooseForToday, tickTask];
