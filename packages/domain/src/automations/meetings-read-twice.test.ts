import { describe, expect, it } from 'vitest';
import type { AutomationDraft } from './automation-rule.ts';
import { meetingsReadTwice, meetingsReadTwiceWarning } from './meetings-read-twice.ts';
import { AFTER_A_MEETING_PRESET, AUTOMATION_PRESETS } from './presets.ts';

/** #793: both meeting presets on read every meeting twice; that is said, never acted on. */

const EXTRACTION = AUTOMATION_PRESETS.find(
  (preset) => preset.name === 'Pull actions and decisions out of a new meeting',
)!;
const off = (rule: AutomationDraft): AutomationDraft => ({ ...rule, enabled: false });

describe('meetingsReadTwice', () => {
  it('names the extraction rule when it and the declared step are both on', () => {
    expect(meetingsReadTwice([AFTER_A_MEETING_PRESET, EXTRACTION])).toEqual([EXTRACTION]);
  });

  it('names nothing when either is off, or only one is there', () => {
    expect(meetingsReadTwice([off(AFTER_A_MEETING_PRESET), EXTRACTION])).toEqual([]);
    expect(meetingsReadTwice([AFTER_A_MEETING_PRESET, off(EXTRACTION)])).toEqual([]);
    expect(meetingsReadTwice([EXTRACTION])).toEqual([]);
    expect(meetingsReadTwice([AFTER_A_MEETING_PRESET])).toEqual([]);
  });

  it('counts a declared step about to be written, for the setup’s preview', () => {
    expect(meetingsReadTwice([EXTRACTION], { declaredComing: true })).toEqual([EXTRACTION]);
    expect(meetingsReadTwice([off(EXTRACTION)], { declaredComing: true })).toEqual([]);
  });

  it('counts only rules set off by a meeting arriving, whatever they are named', () => {
    const byHand: AutomationDraft = { ...EXTRACTION, when: { kind: 'manual' } };
    const onEdit: AutomationDraft = {
      ...EXTRACTION,
      when: { kind: 'note', type: 'meeting', on: ['changed'] },
    };
    const renamed: AutomationDraft = {
      ...EXTRACTION,
      name: 'Meeting actions',
      when: { kind: 'note', type: ' Meeting ', on: ['created'] },
    };
    const declaredByHand: AutomationDraft = { ...AFTER_A_MEETING_PRESET, when: { kind: 'manual' } };
    expect(meetingsReadTwice([AFTER_A_MEETING_PRESET, byHand, onEdit])).toEqual([]);
    expect(meetingsReadTwice([AFTER_A_MEETING_PRESET, renamed])).toEqual([renamed]);
    expect(meetingsReadTwice([declaredByHand, EXTRACTION])).toEqual([]);
  });

  it('never counts a rule with another output, nor a second declared step', () => {
    const other = AUTOMATION_PRESETS.filter(
      (preset) => preset !== EXTRACTION && preset !== AFTER_A_MEETING_PRESET,
    );
    const asNote: AutomationDraft = {
      ...EXTRACTION,
      action: { kind: 'claude', prompt: 'p.md', tools: [], output: { kind: 'note', folder: 'X' } },
    };
    expect(meetingsReadTwice([AFTER_A_MEETING_PRESET, ...other, asNote])).toEqual([]);
    expect(
      meetingsReadTwice([AFTER_A_MEETING_PRESET, { ...AFTER_A_MEETING_PRESET, name: 'Twin' }]),
    ).toEqual([]);
  });
});

describe('meetingsReadTwiceWarning', () => {
  it('says every meeting is read twice, by which rules, and that the other can be turned off', () => {
    const said = meetingsReadTwiceWarning('Meeting actions');
    expect(said).toContain('Every meeting is read twice');
    expect(said).toContain('“After a meeting” and “Meeting actions”');
    expect(said).toContain('turn the other off');
  });
});
