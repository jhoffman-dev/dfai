/**
 * Attack on PR #795 (#793): the read-twice offer turns a rule off through
 * `setEnabled` (use-automations.ts), which is `updateAutomation` with the rule
 * as the listing read it. Each `it.fails` is a bug found; the fix flips it to `it`.
 */
import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_PRESETS,
  builtInPromptAt,
  MEETING_EXTRACTION_PROMPT,
  type AutomationDraft,
} from '@dfai/domain';
import { automationVault } from '../testing/automation-vault.ts';
import { loadAutomations } from './load-automations.ts';
import { createAutomation, updateAutomation } from './save-automation.ts';

const TODAY = '2026-10-14';
const CLOCK = {
  today: () => TODAY,
  localNow: () => `${TODAY}T09:00:00`,
  now: () => Date.parse(`${TODAY}T09:00:00Z`),
};
const EXTRACTION: AutomationDraft = AUTOMATION_PRESETS.find(
  (preset) => preset.name === 'Pull actions and decisions out of a new meeting',
)!;

describe('turning off the rule that reads every meeting twice, edited on disk since it was read (#793 attack)', () => {
  // updateAutomation re-reads the file but writes every frontmatter key from the listing's rule, so an
  // edit made on disk (another editor, sync from the other Mac) since the listing was read is reverted.
  it.fails('keeps the edit made on disk and only turns the rule off, or refuses', async () => {
    const vault = automationVault({
      today: TODAY,
      notes: { [MEETING_EXTRACTION_PROMPT]: builtInPromptAt(MEETING_EXTRACTION_PROMPT)!.contents },
    });
    const { fs, markdown } = vault.ports;
    const path = await createAutomation({
      fs,
      markdown,
      clock: CLOCK,
      draft: EXTRACTION,
      takenPaths: vault.ports.notePaths,
    });
    const [{ rule: listed } = { rule: null }] = (
      await loadAutomations({ fs, markdown, notePaths: vault.ports.notePaths })
    ).automations;
    expect(listed?.name).toBe(EXTRACTION.name);
    const before = vault.files.get(path)!;
    const edited = before.replace('"FROM meeting"', '"FROM meeting WHERE provider = granola"');
    expect(edited).not.toBe(before);
    vault.files.set(path, edited);

    const turnedOff = updateAutomation({
      fs,
      markdown,
      clock: CLOCK,
      rule: listed!,
      draft: { ...listed!, enabled: false },
    }).then(
      () => 'written',
      () => 'refused',
    );

    if ((await turnedOff) === 'refused') {
      expect(vault.files.get(path)).toBe(edited);
      return;
    }
    const [after] = (await loadAutomations({ fs, markdown, notePaths: vault.ports.notePaths }))
      .automations;
    expect(after?.rule.enabled).toBe(false);
    expect(after?.rule.which).toBe('FROM meeting WHERE provider = granola');
  });
});
