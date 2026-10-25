import type { ToolCall } from '@dfai/domain';

/**
 * A tool call in a few words, as the transcript shows it and the chat note
 * records it: "Searched for “Sam”", "Read Projects/Q3.md".
 */
export function describeToolCall(call: ToolCall): string {
  const text = (key: string) => inputText(call, key);
  const archived = call.input['includeArchived'] === true ? ', archive included' : '';
  switch (call.name) {
    case 'atlas_search':
      return `Searched for “${text('q')}”${archived}`;
    case 'atlas_read_note':
      return `Read ${text('path')}`;
    case 'atlas_list_notes':
      return text('folder') === '' ? 'Listed notes' : `Listed notes in ${text('folder')}`;
    case 'atlas_backlinks':
      return `Found what links to ${text('path')}`;
    case 'atlas_list_types':
      return 'Listed the types';
    case 'atlas_list_views':
      return 'Listed the views';
    case 'atlas_list_type_views':
      return `Listed the views of ${text('type')}`;
    case 'atlas_list_templates':
      return 'Listed the templates';
    case 'atlas_read_template':
      return `Read the ${text('name')} template`;
    case 'atlas_run_view':
      return `Ran ${text('path')}${archived}`;
    case 'atlas_run_query':
      return `Ran the query “${text('query')}”`;
    case 'atlas_calendar':
      return `Read the calendar of ${text('path')}`;
    case 'atlas_tags':
      return 'Listed the tags';
    case 'atlas_tagged_notes':
      return `Found notes tagged #${text('tag').replace(/^#/, '')}`;
    case 'atlas_archived':
      return 'Listed the archive';
    case 'atlas_brief':
      return `Read the brief on ${text('entity')}`;
    case 'atlas_open_loops':
      return `Read the open loops of ${text('entity')}`;
    case 'atlas_meeting_quotes':
      return text('about') === ''
        ? `Read the meetings of ${text('entity')}`
        : `Read what was said about “${text('about')}” in the meetings of ${text('entity')}`;
    case 'propose_edit':
      return `Proposed an edit to ${text('path')}`;
    case 'propose_note':
      return `Proposed a new note, “${text('title')}”`;
    case 'propose_tasks':
      return `Drafted the tasks of ${text('meeting')} as proposals`;
    case 'make_dashboard':
      return `Proposed ${specLabel(call)}`;
    default:
      return `Tried a tool that does not exist (${call.name})`;
  }
}

/**
 * A tool call that failed, in a few words: a proposal that was refused says
 * no proposal was made, so neither the pane nor the chat note claims one was.
 */
export function describeFailedToolCall(call: ToolCall): string {
  const text = (key: string) => inputText(call, key);
  switch (call.name) {
    case 'propose_edit':
      return `Could not propose an edit to ${text('path')}`;
    case 'propose_note':
      return `Could not propose a new note, “${text('title')}”`;
    case 'propose_tasks':
      return `Could not draft the tasks of ${text('meeting')}`;
    case 'make_dashboard':
      return `Could not propose ${specLabel(call)}`;
    default:
      return `Failed: ${describeToolCall(call)}`;
  }
}

/** "the dashboard “Payroll”", "the view “Open tasks”", or "a dashboard" when the spec says no more. */
function specLabel(call: ToolCall): string {
  const spec = call.input['spec'];
  const fields = typeof spec === 'object' && spec !== null ? (spec as Record<string, unknown>) : {};
  const kind = fields['kind'] === 'view' ? 'view' : 'dashboard';
  const name = typeof fields['name'] === 'string' ? fields['name'].trim() : '';
  return name === '' ? `a ${kind}` : `the ${kind} “${name}”`;
}

function inputText(call: ToolCall, key: string): string {
  const value = call.input[key];
  return typeof value === 'string' ? value : '';
}
