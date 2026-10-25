/**
 * Every action the work budgets measure, in the order `budgets.spec.ts` does
 * them: each starts from where the one before left the app.
 */
export const BUDGETED_ACTIONS = [
  'Open a vault',
  'Click a sidebar note',
  'Switch notes',
  'Open in a new tab',
  'Switch tabs',
  'Type 10 characters in a note',
  'One autosave and its watcher echo',
  'Idle 3 s with a note open',
  'Split the window',
  'Focus the other pane',
  'Close a pane',
  'Open Settings',
  'Open Today',
  'Idle 3 s on Today',
  'Tick a task on Today',
  'Open the Inbox',
  'Decide an Inbox row',
  "Open a person's page",
  'Open the 420-row table',
  '⌘K + 5 keys over the table',
  'Drag a board card',
  'Run a 2,000-row SQL query',
  'Run a 920-row DFAI query',
  // Ask (#37), from the PDF the pass left open: the page, its chunk, and the recent questions.
  'Open Ask (⌘J)',
  // On the research fixture (#507): 2,000 literature notes holding 20,000 highlights.
  'Open the Library (2,000 sources)',
  'Open All highlights (20,000)',
  'Open a 500-page PDF',
  'Scroll a 500-page PDF to its middle',
  // A generated book of 1,000 chapters, about 30 MB (#505).
  'Open a 1,000-chapter EPUB',
  'Turn a chapter of a 1,000-chapter EPUB',
  'Find in a 1,000-chapter EPUB',
  // On a literature note of 500 highlights, each drawn as its quote and a comment to type in (#534).
  'Open a 500-highlight literature note',
  'Save a comment in a 500-highlight note',
] as const;

export type BudgetedAction = (typeof BUDGETED_ACTIONS)[number];
