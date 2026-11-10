/**
 * Attack on PR #795 (#793): the read-twice offer turns a rule off through
 * `setEnabled` (use-automations.ts), which is `updateAutomation` with the rule
 * as the listing read it. Each test is a bug found, an `it.fails` until it was fixed.
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
import { createAutomation, setAutomationEnabled, updateAutomation } from './save-automation.ts';

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
  it('keeps the edit made on disk and only turns the rule off, or refuses', async () => {
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

describe('turning a rule on or off writes only `enabled`, onto the file as it is now (#793)', () => {
  async function listedThenEdited() {
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
    const listed = (await loadAutomations({ fs, markdown, notePaths: vault.ports.notePaths }))
      .automations[0]!.rule;
    const before = vault.files.get(path)!;
    vault.files.set(
      path,
      before.replace('"FROM meeting"', '"FROM meeting WHERE provider = granola"'),
    );
    const reread = async () =>
      (await loadAutomations({ fs, markdown, notePaths: vault.ports.notePaths })).automations[0]!;
    return { vault, path, listed, reread };
  }

  it('turns it off and keeps the edit made since it was listed', async () => {
    const { vault, listed, reread } = await listedThenEdited();
    await setAutomationEnabled({ ...vault.ports, clock: CLOCK, rule: listed, enabled: false });
    const after = await reread();
    expect(after.rule.enabled).toBe(false);
    expect(after.rule.which).toBe('FROM meeting WHERE provider = granola');
  });

  it('turns it back on, keeping the edit, and logs it as turned on', async () => {
    const { vault, listed, reread } = await listedThenEdited();
    await setAutomationEnabled({ ...vault.ports, clock: CLOCK, rule: listed, enabled: false });
    const off = (await reread()).rule;
    await setAutomationEnabled({ ...vault.ports, clock: CLOCK, rule: off, enabled: true });
    const after = await reread();
    expect(after.rule.enabled).toBe(true);
    expect(after.rule.which).toBe('FROM meeting WHERE provider = granola');
    expect(after.log.filter((entry) => entry.kind === 'turnedOn')).toHaveLength(2);
  });

  it('refuses a file that no longer reads as a rule, and leaves it as it is', async () => {
    const { vault, path, listed } = await listedThenEdited();
    const broken = '---\nnot: a rule\n---\nBody.\n';
    vault.files.set(path, broken);
    await expect(
      setAutomationEnabled({ ...vault.ports, clock: CLOCK, rule: listed, enabled: false }),
    ).rejects.toThrow('changed on disk');
    expect(vault.files.get(path)).toBe(broken);
  });

  it('refuses an editor’s save over a file edited since it was listed, and leaves the edit', async () => {
    const { vault, path, listed } = await listedThenEdited();
    const edited = vault.files.get(path)!;
    await expect(
      updateAutomation({
        ...vault.ports,
        clock: CLOCK,
        rule: listed,
        draft: { ...listed, name: 'Meeting actions, renamed' },
      }),
    ).rejects.toThrow('changed on disk');
    expect(vault.files.get(path)).toBe(edited);
  });

  it('saves an editor’s change over a file unchanged since it was listed', async () => {
    const { vault, listed, reread } = await listedThenEdited();
    const fresh = (await reread()).rule;
    await updateAutomation({
      ...vault.ports,
      clock: CLOCK,
      rule: fresh,
      draft: { ...fresh, name: 'Meeting actions, renamed' },
    });
    expect((await reread()).rule).toMatchObject({
      name: 'Meeting actions, renamed',
      which: 'FROM meeting WHERE provider = granola',
    });
    expect(listed.which).toBe('FROM meeting');
  });
});
