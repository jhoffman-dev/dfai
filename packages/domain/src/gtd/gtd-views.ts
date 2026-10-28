/**
 * The views GTD is worked from (ADR-0029), written into `.atlas/views` with
 * the migration when the vault has no view of the name. Each is a query view
 * (ADR-0019), so it reads and edits like any other.
 */
export interface GtdViewFile {
  /** The view's file name in `.atlas/views`, without `.md`. */
  readonly name: string;
  readonly layout: 'list' | 'board';
  readonly query: string;
  readonly body: string;
}

/**
 * Next actions: what can be done now. A task deferred to a later day is left
 * out until that day comes; `@today` is worked out when the view runs.
 */
export const NEXT_ACTIONS_QUERY = [
  'FROM task',
  'WHERE status = next-action AND (defer IS EMPTY OR defer <= @today)',
  'SORT BY due',
  'SHOW status, contexts, due, project',
].join('\n');

/**
 * The open tasks chosen for today (#108), as the planning tray reads them:
 * `@today` is the query language's, as it is in every view. One deferred to
 * a later day is left out, as Today leaves it out.
 */
export const CHOSEN_TODAY_QUERY = [
  'FROM task',
  'WHERE focus = @today AND status != archive AND (defer IS EMPTY OR defer <= @today)',
  'SORT BY due',
].join('\n');

export const GTD_VIEW_FILES: readonly GtdViewFile[] = [
  {
    name: 'Inbox',
    layout: 'list',
    query: ['FROM task', 'WHERE status = inbox', 'SORT BY title', 'SHOW status, source'].join('\n'),
    body: '# Inbox\n\nTasks captured and not yet processed: decide what each one is, then give it a status.\n',
  },
  {
    name: 'Next actions',
    layout: 'list',
    query: NEXT_ACTIONS_QUERY,
    body: '# Next actions\n\nWhat can be done now. A task deferred to a later day stays out of here until that day.\n',
  },
  {
    name: 'Waiting',
    layout: 'list',
    query: [
      'FROM task',
      'WHERE status = waiting',
      'SORT BY due',
      'GROUP BY waiting_on',
      'SHOW waiting_on, due, project',
    ].join('\n'),
    body: '# Waiting\n\nEverything waiting on someone else, by who it waits on.\n',
  },
  {
    name: 'Someday and Longterm',
    layout: 'board',
    query: [
      'FROM task',
      'WHERE status = someday OR status = longterm',
      'SORT BY title',
      'GROUP BY status',
      'SHOW status, project',
    ].join('\n'),
    body: '# Someday and Longterm\n\nIdeas kept for later, and work that is a long way off. Drag a card between the two.\n',
  },
];
