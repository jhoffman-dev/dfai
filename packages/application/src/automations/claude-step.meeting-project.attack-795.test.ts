/**
 * Attack on PR #795 (#793): the declared step's list of projects, capped at
 * MAX_PROJECT_CHOICES with the ties to the meeting's people and companies
 * first. Over the fake vault whose index answers with real SQL and a scripted
 * model. Each test is a bug found, an `it.fails` until it was fixed.
 */
import { describe, expect, it } from 'vitest';
import {
  AFTER_A_MEETING_PROMPT,
  builtInPromptAt,
  createVaultPath,
  MAX_PROJECT_CHOICES,
  parseObjectType,
  type AutomationRule,
} from '@dfai/domain';
import type { ModelEvent } from '../chat/ports.ts';
import {
  automationVault,
  jsonNote,
  TASK_TYPES,
  type IndexedLink,
} from '../testing/automation-vault.ts';
import { recordingActivity } from '../testing/fake-activity.ts';
import { fakeClaudeStepPorts } from '../testing/fake-claude-step.ts';
import { MEETING_BODY, MEETING_HEADER } from '../testing/meeting-files.ts';
import { runAutomation } from './run-automation.ts';
import type { VaultGuard } from './vault-guard.ts';

const TODAY = '2026-10-14';
const CLOCK = {
  today: () => TODAY,
  localNow: () => `${TODAY}T09:00:00`,
  now: () => Date.parse(`${TODAY}T09:00:00Z`),
};
const GUARD: VaultGuard = { vault: '/vaults/home', currentVault: () => '/vaults/home' };
const TYPES = [
  ...TASK_TYPES,
  parseObjectType({ name: 'meeting', label: 'Meeting', properties: { date: 'date' } }),
];
const RULE: AutomationRule = {
  id: 'After a meeting',
  path: createVaultPath('.atlas/automations/After a meeting.md'),
  name: 'After a meeting',
  enabled: true,
  when: { kind: 'note', type: 'meeting', on: ['created'] },
  which: 'FROM meeting WHERE date >= @-14d',
  olderThanDays: null,
  action: {
    kind: 'claude',
    prompt: AFTER_A_MEETING_PROMPT,
    tools: [],
    output: { kind: 'proposals', schema: 'meeting-items' },
    apply: 'mine',
  },
};
const NOTHING: ModelEvent[] = [{ type: 'text', text: JSON.stringify({ items: [] }) }];
const LET_IN = { ...MEETING_HEADER, atlas_import_outcome: 'imported' };
const MEETING = 'Meetings/2026-10-06 Standup.md';
const ZINNIA = 'Projects/Zinnia rollout.md';
/** The same standup the weeks before, each filed under Zinnia rollout: its series. */
const EARLIER = ['2026-09-22', '2026-09-29'].map((date) => ({
  path: `Meetings/${date} Standup.md`,
  text: jsonNote(
    {
      ...LET_IN,
      date,
      external_id: `gemini-${date}`,
      project: '[[Zinnia rollout]]',
    },
    MEETING_BODY,
  ),
}));

describe('the declared step’s capped list of projects (#793 attack)', () => {
  // shownOptions (domain meeting-project-choice.ts) puts only the people/companies ties first. The
  // project linking proposes first is the series' or twin's (meeting-link-plan.ts projectProposal),
  // and the choice instructions tell Claude to judge by "its earlier meetings": with no person
  // linked, that project falls to the alphabetical cut and Claude cannot choose it.
  it('shows the project the meeting’s own series is filed under, though no person ties it', async () => {
    const aster = Object.fromEntries(
      Array.from({ length: 45 }, (_, at) => [
        `Projects/Aster ${String(at).padStart(2, '0')}.md`,
        jsonNote({ type: 'project', status: 'active' }),
      ]),
    );
    const links: IndexedLink[] = EARLIER.map(({ path }) => ({
      src: path,
      key: 'project',
      dst: ZINNIA,
    }));
    const claude = fakeClaudeStepPorts({
      rounds: [NOTHING],
      model: 'claude-opus-5-5',
      today: TODAY,
    });
    const vault = automationVault({
      notes: {
        [AFTER_A_MEETING_PROMPT]: builtInPromptAt(AFTER_A_MEETING_PROMPT)!.contents,
        [MEETING]: jsonNote(LET_IN, MEETING_BODY),
        ...Object.fromEntries(EARLIER.map(({ path, text }) => [path, text])),
        ...aster,
        [ZINNIA]: jsonNote({ type: 'project', status: 'active' }),
      },
      today: TODAY,
      types: TYPES,
      claude,
      links,
    });

    await runAutomation({
      ports: vault.ports,
      rule: { ...RULE, which: 'FROM meeting WHERE date = 2026-10-06' },
      clock: CLOCK,
      guard: GUARD,
      activity: recordingActivity(),
      trigger: 'hand',
    });

    const system = claude.fake.requests[0]!.system;
    const listed = system.split('\n').filter((line) => / — .* \((project|area)\)$/.test(line));
    expect(listed).toHaveLength(MAX_PROJECT_CHOICES);
    expect(listed).toContain(`- ${ZINNIA} — Zinnia rollout (project)`);
  });
});
