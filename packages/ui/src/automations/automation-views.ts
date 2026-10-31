/** What the Automations page is handed: each rule and its log, already put into words. */

/** One rule, as its row in the list says it. */
export interface AutomationRow {
  /** The rule file's path: what every command names it by. */
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  /** "Every day at 03:00". */
  readonly schedule: string;
  /** "Archive", "Set status to done". */
  readonly action: string;
  /** "27 Sep, 03:00 · Archived 12 notes." — null when it has never run. */
  readonly lastRun: string | null;
  /** "28 Sep, 03:00" — null when it only runs on opening or by hand, or is off. */
  readonly nextRun: string | null;
  readonly canUndo: boolean;
  /** Why the rule's file cannot be read; such a rule never runs. */
  readonly problem: string | null;
  /** Something the rule's runs are held up by — paused, or a log dated ahead — said beside it. */
  readonly notice: string | null;
}

/** One line under a log entry: a thing done, or a note left alone and why. */
export interface LogLineView {
  readonly kind: 'done' | 'left';
  readonly text: string;
}

export interface LogEntryView {
  readonly id: string;
  /** "27 Sep 2026, 03:00:12 · Ran on schedule". */
  readonly heading: string;
  readonly summary: string;
  readonly lines: readonly LogLineView[];
}

/** A dry run's answer: what the rule would do now, or why it cannot say. */
export type DryRunView =
  | {
      readonly kind: 'plan';
      readonly summary: string;
      readonly notes: readonly { readonly path: string; readonly title: string }[];
      readonly passedOver: readonly { readonly title: string; readonly reason: string }[];
      /** Meetings whose linking failed, which Run now links again first (#192); left out for none. */
      readonly notLinked?: readonly { readonly path: string; readonly title: string }[];
    }
  | { readonly kind: 'error'; readonly message: string };
