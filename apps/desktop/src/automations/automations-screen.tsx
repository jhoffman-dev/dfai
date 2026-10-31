import {
  AUTOMATION_PRESETS,
  CHAT_READ_TOOLS,
  createVaultPath,
  planClockLabel,
  PROPOSAL_SCHEMAS,
  type VaultPath,
} from '@dfai/domain';
import {
  planNowOf,
  type ActivityLog,
  type AutomationPorts,
  type Clock,
  type RuleQueryPorts,
} from '@dfai/application';
import {
  AutomationEditor,
  AutomationsPage,
  MeetingSetup,
  QueryComposer,
  type MeetingSetupProps,
  type PageHistory,
} from '@dfai/ui';
import { useSkillChoices } from '../skills/use-skill-choices.ts';
import { localTimeZone } from '../today.ts';
import { automationRows, logViews } from './automation-rows.ts';
import { useAutomationEditor } from './use-automation-editor.ts';
import type { useAutomations } from './use-automations.ts';

const PRESET_NAMES = AUTOMATION_PRESETS.map((preset) => preset.name);
const CLAUDE_OUTPUTS = Object.keys(PROPOSAL_SCHEMAS);

/**
 * The Automations page as a page (P25-03): the list of rules and, above it,
 * the one open in the editor with its dry run and its log. It takes the place
 * of the panes, as the Archive does.
 */
export function AutomationsScreen({
  automations,
  ports,
  clock,
  indexKey,
  activity,
  vault,
  onOpenNote,
  onShowSidebar,
  history,
  setup = null,
}: {
  automations: ReturnType<typeof useAutomations>;
  ports: AutomationPorts & Pick<RuleQueryPorts, 'notePaths'>;
  clock: Pick<Clock, 'today' | 'now' | 'localNow'>;
  indexKey: string;
  activity: ActivityLog;
  /** The open vault: whose skills the editor offers. */
  vault: string | null;
  onOpenNote: (path: VaultPath) => void;
  onShowSidebar?: () => void;
  history?: PageHistory;
  /** The offer to set meeting post-processing up in one yes (#191). */
  setup?: MeetingSetupProps | null;
}) {
  const editor = useAutomationEditor({ automations, ports, clock, indexKey, activity });
  // Read only while a rule is open in the editor: the list itself needs no skills.
  const skills = useSkillChoices({
    fs: ports.fs,
    markdown: ports.markdown,
    vault,
    enabled: editor.editing !== null,
  });
  const { listing, watchingSince, pauses, planZone } = automations;
  const planNow = planNowOf(clock, planZone);
  const planClock = planClockLabel({ planZone, macZone: localTimeZone() });
  const rows =
    listing === null || watchingSince === null
      ? null
      : automationRows(listing, {
          watchingSince,
          now: clock.localNow(),
          pauses,
          planNow,
          planClock,
        });
  const loadedOf = (id: string) =>
    listing?.automations.find((loaded) => loaded.rule.path === id) ?? null;
  const open = editor.editing?.kind === 'rule' ? loadedOf(editor.editing.rule.path) : null;
  const openNote = (path: string) => onOpenNote(createVaultPath(path));

  return (
    <AutomationsPage
      rows={rows}
      error={automations.error}
      openId={open?.rule.path ?? null}
      presets={PRESET_NAMES}
      notice={automations.notice}
      busy={automations.busy}
      setup={setup === null ? null : <MeetingSetup {...setup} />}
      onNew={editor.newRule}
      onAddPreset={editor.addPreset}
      onOpen={(id) => {
        const loaded = loadedOf(id);
        if (loaded !== null) editor.openRule(loaded.rule);
      }}
      onToggle={(id, enabled) => {
        const loaded = loadedOf(id);
        if (loaded !== null) void automations.setEnabled(loaded.rule, enabled);
      }}
      onRunNow={(id) => {
        const loaded = loadedOf(id);
        if (loaded !== null) void automations.runNow(loaded.rule);
      }}
      editor={
        editor.editing === null ? null : (
          <AutomationEditor
            key={editor.opened}
            draft={editor.editing.draft}
            onChange={editor.change}
            isNew={editor.editing.kind === 'new'}
            problem={editor.problem}
            which={<QueryComposer {...editor.composer} />}
            typeNames={ports.types.map((type) => type.name)}
            claudeTools={CHAT_READ_TOOLS}
            claudeOutputs={CLAUDE_OUTPUTS}
            skills={skills}
            busy={automations.busy}
            onSave={editor.save}
            onCancel={editor.close}
            onDryRun={editor.runDry}
            onRunNow={() => {
              editor.forgetDryRun();
              if (open !== null) void automations.runNow(open.rule);
            }}
            onUndo={() => {
              editor.forgetDryRun();
              if (open !== null) void automations.undo(open.rule);
            }}
            canUndo={
              open !== null && rows?.find((row) => row.id === open.rule.path)?.canUndo === true
            }
            dryRun={editor.dryRun}
            log={open === null ? [] : logViews(open.log)}
            onOpenNote={openNote}
          />
        )
      }
      {...(onShowSidebar !== undefined && { onShowSidebar })}
      {...(history !== undefined && { history })}
    />
  );
}
