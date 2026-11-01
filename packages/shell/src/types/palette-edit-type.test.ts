import { describe, expect, it, vi } from 'vitest';
import { paletteEditTypeOffers, runPaletteEditTypeCommand } from './palette-edit-type.ts';

const types = [
  { name: 'task', label: 'Task' },
  { name: 'project', label: 'Project' },
];
const labels = (query: string) =>
  paletteEditTypeOffers(types, query).map((command) => command.label);

describe('Edit type and Edit template in the palette', () => {
  it('offers each type’s definition to “edit type”, and its template to “edit template”', () => {
    expect(labels('edit type')).toEqual(['Edit Task type', 'Edit Project type']);
    expect(labels('edit template')).toEqual(['Edit Task template', 'Edit Project template']);
  });

  it('offers both for one type to its name', () => {
    expect(labels('Edit task')).toEqual(['Edit Task type', 'Edit Task template']);
  });

  it('stays out of an ordinary search, even one for a type’s name', () => {
    expect(labels('task')).toEqual([]);
    expect(labels('task template')).toEqual([]);
    expect(labels('editor')).toEqual([]);
    expect(labels('')).toEqual([]);
  });

  it('opens the type or the template a command names, and leaves other commands alone', () => {
    const editType = vi.fn();
    const editTemplate = vi.fn();
    const run = (id: string) => runPaletteEditTypeCommand(id, { editType, editTemplate });
    const offers = paletteEditTypeOffers(types, 'edit project');
    expect(run(offers.find((offer) => offer.label.endsWith('type'))!.id)).toBe(true);
    expect(editType).toHaveBeenCalledExactlyOnceWith('project');
    expect(run(offers.find((offer) => offer.label.endsWith('template'))!.id)).toBe(true);
    expect(editTemplate).toHaveBeenCalledExactlyOnceWith('project');
    expect(run('new-view')).toBe(false);
    expect(editType).toHaveBeenCalledOnce();
    expect(editTemplate).toHaveBeenCalledOnce();
  });
});
