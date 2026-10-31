import { describe, expect, it } from 'vitest';
import { newWidgetDraft, type ObjectType } from '@dfai/domain';
import { editorChoices } from './editor-choices.ts';

const TASK: ObjectType = {
  name: 'task',
  label: 'Task',
  properties: [
    {
      key: 'status',
      kind: 'select',
      label: 'Status',
      required: false,
      options: ['next-action', 'archive'],
      target: null,
      many: false,
    },
  ],
};

describe('editorChoices', () => {
  it('offers a widget’s filter the options its type declares, by label (#212)', () => {
    const { fields } = editorChoices({
      draft: newWidgetDraft({ kind: 'number', type: 'task' }),
      types: [TASK],
      savedViews: [],
    });
    expect(fields.find((field) => field.key === 'status')?.choices).toEqual([
      { value: 'next-action', label: 'Next Action' },
      { value: 'archive', label: 'Archive' },
    ]);
  });
});
