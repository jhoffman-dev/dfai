import { describe, expect, it } from 'vitest';
import { createVaultPath } from '@dfai/domain';
import type { PeopleMergePreview } from '@dfai/application';
import { duplicateReasonView, mergePreviewView, personChoice } from './people-merge-views.ts';

const p = createVaultPath;

describe('the merge’s words', () => {
  it('names a person by title and folder, none at the top', () => {
    expect(personChoice(p('People/Mara Quill.md'))).toEqual({
      path: 'People/Mara Quill.md',
      name: 'Mara Quill',
      place: 'People',
    });
    expect(personChoice(p('Mara.md')).place).toBe('');
  });

  it('counts the notes whose links change, not the kept note, and shows values as text', () => {
    const preview: PeopleMergePreview = {
      keep: p('People/Mara Quill.md'),
      merge: [p('Mara.md')],
      refusal: null,
      blockedByTyping: false,
      plan: {
        changes: {},
        conflicts: [{ key: 'teams', kept: ['Payroll', 'Audit'], other: 3, from: p('Mara.md') }],
        aliasesAdded: ['Mara'],
        emailsAdded: [],
        appended: [{ from: p('Mara.md'), heading: '## Merged from Mara', body: 'x' }],
      },
      writes: [
        { path: p('Kickoff.md'), before: '', after: '', links: 2 },
        { path: p('People/Mara Quill.md'), before: '', after: '', links: 1 },
      ],
      links: 3,
      merged: [],
      version: 'v1',
    };
    expect(mergePreviewView(preview)).toEqual({
      keep: 'Mara Quill',
      merge: ['Mara'],
      notes: 1,
      links: 3,
      conflicts: [{ key: 'teams', kept: 'Payroll, Audit', other: '3', from: 'Mara' }],
      aliasesAdded: ['Mara'],
      emailsAdded: [],
      bodies: 1,
    });
  });

  it('gives each reason its own words and hue, the addresses beside the chip', () => {
    expect(duplicateReasonView({ kind: 'same-name' })).toEqual({ text: 'Same name', hue: 'blue' });
    expect(
      duplicateReasonView({
        kind: 'similar-email',
        left: 'mara.quill@larkspur.example.com',
        right: 'marra.quill@larkspor.example.com',
        local: 'typo',
        sameDomain: false,
      }),
    ).toEqual({
      text: 'Email a typo apart, near domain',
      hue: 'orange',
      detail: 'mara.quill@larkspur.example.com · marra.quill@larkspor.example.com',
    });
  });
});
