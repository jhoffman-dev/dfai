import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AUTOMATION_PRESETS,
  automationNameProblem,
  BLANK_AUTOMATION,
  draftProblem,
  setValueFromInput,
  type AutomationDraft,
  type AutomationRule,
} from '@dfai/domain';
import {
  AtlasQueryError,
  createAutomation,
  dryRunAutomation,
  updateAutomation,
  type ActivityLog,
  type AutomationPorts,
  type RuleQueryPorts,
  type Clock,
} from '@dfai/application';
import type { DryRunView, QueryComposerProps } from '@dfai/ui';
import { errorMessage } from '../query/error-message.ts';
import { useAtlasQuery } from '../query/use-atlas-query.ts';
import { useQueryChoices } from '../query/use-query-choices.ts';
import { dryRunView } from './automation-rows.ts';
import type { useAutomations } from './use-automations.ts';

/** What the editor holds: a rule being made, or the one open, as it is being changed. */
type Editing =
  | { readonly kind: 'new'; readonly draft: AutomationDraft }
  | { readonly kind: 'rule'; readonly rule: AutomationRule; readonly draft: AutomationDraft };

/**
 * The value typed for a property, as the rule keeps it: `true` a checkbox's,
 * `3` a number. The editor holds what was typed; the rule is written from this.
 */
function normalised(draft: AutomationDraft): AutomationDraft {
  if (draft.action.kind !== 'set') return draft;
  const values = Object.fromEntries(
    Object.entries(draft.action.values).map(([key, value]) => [
      key.trim(),
      typeof value === 'string' ? setValueFromInput(value) : value,
    ]),
  );
  return { ...draft, action: { kind: 'set', values } };
}

/**
 * The Automations page's editor (P25-03): one rule at a time, new or open,
 * with the query builder for "which notes", a dry run of what it would do
 * today, and saving through the runner's one-at-a-time door.
 */
export function useAutomationEditor({
  automations,
  ports,
  clock,
  indexKey,
  activity,
}: {
  automations: ReturnType<typeof useAutomations>;
  ports: AutomationPorts & Pick<RuleQueryPorts, 'notePaths'>;
  clock: Pick<Clock, 'today' | 'now' | 'localNow'>;
  indexKey: string;
  /** Where a dry run is said (U-28). */
  activity: ActivityLog;
}) {
  const [editing, setEditing] = useState<Editing | null>(null);
  // Counts each rule opened or begun, so the editor's own state starts afresh for each.
  const [opened, setOpened] = useState(0);
  const [dryRun, setDryRun] = useState<DryRunView | null>(null);
  const query = useAtlasQuery({
    initialText: '',
    index: ports.index,
    types: ports.types,
    notePaths: ports.notePaths,
    indexKey,
    enabled: editing !== null,
  });
  const choices = useQueryChoices({
    index: ports.index,
    types: ports.types,
    fields: query.fields,
    notePaths: ports.notePaths,
    indexKey,
  });

  // The builder's text is the rule's "which".
  useEffect(() => {
    setEditing((was) =>
      was === null || was.draft.which === query.text
        ? was
        : { ...was, draft: { ...was.draft, which: query.text } },
    );
  }, [query.text]);

  const { load } = query;
  const start = useCallback(
    (next: Editing) => {
      setEditing(next);
      setOpened((count) => count + 1);
      setDryRun(null);
      load(next.draft.which);
    },
    [load],
  );

  const change = useCallback((draft: AutomationDraft) => {
    setEditing((was) => (was === null ? was : { ...was, draft }));
    setDryRun(null);
  }, []);

  const draft = editing === null ? null : normalised(editing.draft);
  const problem = useMemo(() => {
    if (editing === null || draft === null) return null;
    const naming =
      editing.kind === 'new'
        ? automationNameProblem(draft.name, ports.notePaths)
        : draft.name.trim() === ''
          ? 'Name the automation.'
          : null;
    return naming ?? draftProblem(draft);
  }, [editing, draft, ports.notePaths]);

  const { listing } = automations;
  const runDry = useCallback(async () => {
    if (draft === null || editing === null) return;
    const named = {
      name: draft.name.trim(),
      path: editing.kind === 'rule' ? editing.rule.path : null,
    };
    // What the rule has handled, for one notes set off: its log as last read.
    const loaded =
      editing.kind === 'rule'
        ? listing?.automations.find((each) => each.rule.path === editing.rule.path)
        : undefined;
    const log = loaded?.log ?? [];
    try {
      const plan = await dryRunAutomation({
        ports,
        rule: loaded === undefined ? draft : { ...draft, id: loaded.rule.id },
        log,
        ledger: loaded?.ledger ?? null,
        named,
        today: clock.today(),
        at: clock.localNow(),
        activity,
      });
      setDryRun(dryRunView(plan));
    } catch (cause) {
      setDryRun({
        kind: 'error',
        message: cause instanceof AtlasQueryError ? cause.message : errorMessage(cause),
      });
    }
  }, [draft, editing, listing, ports, clock, activity]);

  const { exclusive, setNotice } = automations;
  const save = useCallback(async () => {
    if (editing === null || draft === null || problem !== null) return;
    const written = { fs: ports.fs, markdown: ports.markdown, clock };
    // A save waits for a run under way rather than being dropped while the person is told nothing.
    const saved = await exclusive(
      async () => {
        if (editing.kind === 'new') {
          return createAutomation({ ...written, draft, takenPaths: ports.notePaths });
        }
        await updateAutomation({ ...written, rule: editing.rule, draft });
        return editing.rule.path;
      },
      { wait: true },
    );
    if (saved === null) return;
    setNotice(`Saved “${draft.name.trim()}”.`);
    setEditing(null);
  }, [editing, draft, problem, ports, clock, exclusive, setNotice]);

  const composer: QueryComposerProps = {
    mode: query.mode,
    onMode: query.setMode,
    text: query.text,
    onTextChange: query.setText,
    problem: query.problem,
    onRun: query.rerun,
    builder: query.builder,
    onBuilderChange: query.setBuilder,
    textOnly: query.textOnly,
    choices: {
      types: choices.typeChoices,
      fields: query.fields,
      valueChoices: choices.valueChoices,
    },
  };

  return {
    editing,
    opened,
    problem,
    dryRun,
    composer,
    change,
    runDry: () => void runDry(),
    save: () => void save(),
    close: () => setEditing(null),
    /** A run or an undo moves notes: the dry run before it no longer says what would happen. */
    forgetDryRun: () => setDryRun(null),
    newRule: () =>
      start({ kind: 'new', draft: { ...BLANK_AUTOMATION, which: firstTypeQuery(ports) } }),
    /** Opens a ready-made rule in the editor, to be looked over and created. */
    addPreset: (name: string) => {
      const preset = AUTOMATION_PRESETS.find((each) => each.name === name);
      if (preset !== undefined) start({ kind: 'new', draft: preset });
    },
    openRule: (rule: AutomationRule) => start({ kind: 'rule', rule, draft: rule }),
  };
}

/** A new rule starts from every note of the vault's first type, as a new query does. */
function firstTypeQuery(ports: Pick<AutomationPorts, 'types'>): string {
  const first = ports.types[0]?.name;
  return first === undefined ? '' : `FROM ${first}`;
}
