import { describe, expect, it } from 'vitest';
import { describeFailedToolCall, describeToolCall } from './tool-labels.ts';

const said = (name: string, input: Record<string, unknown> = {}) =>
  describeToolCall({ id: 'c', name, input });

describe('describeToolCall', () => {
  it('says what each tool did, in a few words', () => {
    expect(said('atlas_search', { q: 'Sam' })).toBe('Searched for “Sam”');
    expect(said('atlas_search', { q: 'Sam', includeArchived: true })).toBe(
      'Searched for “Sam”, archive included',
    );
    expect(said('atlas_read_note', { path: 'Q3.md' })).toBe('Read Q3.md');
    expect(said('atlas_list_notes')).toBe('Listed notes');
    expect(said('atlas_list_notes', { folder: 'Tasks' })).toBe('Listed notes in Tasks');
    expect(said('atlas_backlinks', { path: 'Q3.md' })).toBe('Found what links to Q3.md');
    expect(said('atlas_list_types')).toBe('Listed the types');
    expect(said('atlas_list_views')).toBe('Listed the views');
    expect(said('atlas_list_type_views', { type: 'task' })).toBe('Listed the views of task');
    expect(said('atlas_list_templates', {})).toBe('Listed the templates');
    expect(said('atlas_read_template', { name: 'Person' })).toBe('Read the Person template');
    expect(said('atlas_run_view', { path: 'Board.md' })).toBe('Ran Board.md');
    expect(said('atlas_run_query', { query: 'FROM task' })).toBe('Ran the query “FROM task”');
    expect(said('atlas_calendar', { path: 'Cal.md' })).toBe('Read the calendar of Cal.md');
    expect(said('atlas_tags')).toBe('Listed the tags');
    expect(said('atlas_tagged_notes', { tag: '#idea' })).toBe('Found notes tagged #idea');
    expect(said('atlas_archived')).toBe('Listed the archive');
    expect(said('atlas_brief', { entity: 'People/Mara Quill.md' })).toBe(
      'Read the brief on People/Mara Quill.md',
    );
    expect(said('atlas_open_loops', { entity: 'Projects/Q3.md' })).toBe(
      'Read the open loops of Projects/Q3.md',
    );
    expect(said('atlas_meeting_quotes', { entity: 'People/Mara Quill.md' })).toBe(
      'Read the meetings of People/Mara Quill.md',
    );
    expect(said('atlas_meeting_quotes', { entity: 'People/Mara Quill.md', about: 'bank' })).toBe(
      'Read what was said about “bank” in the meetings of People/Mara Quill.md',
    );
    expect(said('propose_edit', { path: 'Q3.md' })).toBe('Proposed an edit to Q3.md');
    expect(said('propose_note', { title: 'Idea' })).toBe('Proposed a new note, “Idea”');
    expect(said('propose_tasks', { meeting: 'Meetings/Sync.md' })).toBe(
      'Drafted the tasks of Meetings/Sync.md as proposals',
    );
    expect(said('make_dashboard', { spec: { kind: 'dashboard', name: ' Payroll ' } })).toBe(
      'Proposed the dashboard “Payroll”',
    );
    expect(said('make_dashboard', { spec: { kind: 'view', name: 'Open tasks' } })).toBe(
      'Proposed the view “Open tasks”',
    );
    expect(said('make_dashboard', { spec: 'x' })).toBe('Proposed a dashboard');
  });

  it('names a tool that does not exist, and shows nothing for input that is not text', () => {
    expect(said('rm_rf')).toBe('Tried a tool that does not exist (rm_rf)');
    expect(said('atlas_read_note', { path: 7 })).toBe('Read ');
  });

  it('says a call that failed did not do what it would have', () => {
    const failed = (name: string, input: Record<string, unknown> = {}) =>
      describeFailedToolCall({ id: 'c', name, input });
    expect(failed('propose_edit', { path: 'Q3.md' })).toBe('Could not propose an edit to Q3.md');
    expect(failed('propose_note', { title: 'Idea' })).toBe('Could not propose a new note, “Idea”');
    expect(failed('propose_tasks', { meeting: 'Meetings/Sync.md' })).toBe(
      'Could not draft the tasks of Meetings/Sync.md',
    );
    expect(failed('make_dashboard', { spec: { kind: 'view', name: 'Doing' } })).toBe(
      'Could not propose the view “Doing”',
    );
    expect(failed('atlas_read_note', { path: 'Q3.md' })).toBe('Failed: Read Q3.md');
  });
});
