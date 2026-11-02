// @vitest-environment jsdom
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  createVaultPath,
  pageTitle,
  NO_LINKS,
  type EditorDocument,
  type NoteLinks,
  type PropertyDef,
} from '@dfai/domain';
import {
  NotePane,
  type NotePaneProps,
  type NotePaneState,
  type PageHeading,
} from './note-pane.tsx';
import type { NewProperty } from './properties-panel.tsx';

const doc: EditorDocument = { type: 'doc', content: [] } as unknown as EditorDocument;

const ready = (overrides: Partial<Extract<NotePaneState, { kind: 'ready' }>> = {}) =>
  ({
    kind: 'ready',
    title: 'A15-03',
    doc,
    dirty: false,
    saving: false,
    saveError: null,
    ...overrides,
  }) as const;

const heading = (overrides: Partial<PageHeading> = {}): PageHeading => ({
  kind: 'note',
  crumb: { icon: 'folder', parent: 'tasks' },
  title: { text: 'A15-03', source: 'file' },
  description: null,
  path: 'tasks/A15-03.md',
  sql: null,
  ...overrides,
});

const def = (key: string): PropertyDef => ({
  key,
  kind: 'text',
  label: key,
  required: false,
  options: [],
  target: null,
  many: false,
});

function baseProps(): NotePaneProps {
  return {
    state: ready(),
    heading: heading(),
    arrangement: {},
    onChange: vi.fn(),
    onSave: vi.fn(),
    onFollowLink: vi.fn(),
    suggestNotes: () => [],
    links: NO_LINKS,
    mentions: { kind: 'idle' },
    onFindMentions: vi.fn(),
    onLinkMention: vi.fn(),
    onOpenNote: vi.fn(),
    loadImage: async () => null,
    typeName: 'task',
    properties: [{ def: def('estimate'), value: '3h', error: null }],
    propertyKeys: [],
    relationChoices: {},
    typeLabel: 'Task',
    relationTargets: [],
    onChangeProperty: vi.fn(),
    onAddProperty: vi.fn(async (property: NewProperty) => property.key),
    onRename: vi.fn(),
    onOverwrite: vi.fn(),
    onDiscard: vi.fn(),
    favorite: false,
    onToggleFavorite: vi.fn(),
    // A stand-in body, so these tests are about the page and not the editor.
    body: undefined,
  };
}

function show(overrides: Partial<NotePaneProps> = {}) {
  const props: NotePaneProps = { ...baseProps(), ...overrides };
  render(<NotePane {...props} />);
  return props;
}

const openMenu = () => userEvent.click(screen.getByRole('button', { name: 'More' }));
const item = (name: RegExp) => screen.findByRole('menuitem', { name });

describe('NotePane: the bar', () => {
  it('says where the page is: the folder, then its name', () => {
    show();
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(crumbs.textContent).toBe('tasks/A15-03');
  });

  it.each([
    [{ dirty: false, saving: false }, 'Saved'],
    [{ dirty: true, saving: false }, 'Unsaved'],
    [{ dirty: true, saving: true }, 'Saving…'],
  ])('reads %j as %s, in place of a Save button', (state, text) => {
    show({ state: ready(state) });
    // A live region, so a change from Unsaved to Saved is announced.
    expect(screen.getByRole('status').textContent).toBe(text);
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('saves from the menu when there is something to save', async () => {
    const { onSave } = show({ state: ready({ dirty: true }) });
    await openMenu();
    await userEvent.click(await item(/^Save now/));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('offers no save while there is nothing to save, or while one is running', async () => {
    show({ state: ready({ dirty: true, saving: true }) });
    await openMenu();
    expect((await item(/^Save now/)).getAttribute('aria-disabled')).toBe('true');
  });

  it('offers the conflict choices under the bar when a save is refused', async () => {
    const { onOverwrite, onDiscard } = show({
      state: ready({ dirty: true, saveError: 'The file changed on disk.' }),
    });
    expect(screen.getByRole('alert').textContent).toBe('The file changed on disk.');
    await userEvent.click(screen.getByRole('button', { name: 'Overwrite the file' }));
    await userEvent.click(screen.getByRole('button', { name: 'Discard my changes' }));
    expect(onOverwrite).toHaveBeenCalled();
    expect(onDiscard).toHaveBeenCalled();
  });

  it('offers to keep mine as a copy where the pane can, and not where it cannot', async () => {
    const onKeepAsCopy = vi.fn();
    const refused = ready({ dirty: true, saveError: 'The file changed on disk.' });
    show({ state: refused, onKeepAsCopy });
    await userEvent.click(screen.getByRole('button', { name: 'Keep mine as a copy' }));
    expect(onKeepAsCopy).toHaveBeenCalledTimes(1);
    cleanup();
    show({ state: refused });
    expect(screen.getByRole('button', { name: 'Overwrite the file' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Keep mine as a copy' })).toBeNull();
  });

  it('holds the copy button while a keep is under way, so one click makes one copy', () => {
    show({
      state: ready({ dirty: true, saving: true, saveError: 'The file changed on disk.' }),
      onKeepAsCopy: vi.fn(),
    });
    expect(
      (screen.getByRole('button', { name: 'Keep mine as a copy' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('stars the page by its title', async () => {
    const { onToggleFavorite } = show();
    await userEvent.click(screen.getByRole('button', { name: 'Add A15-03 to favorites' }));
    expect(onToggleFavorite).toHaveBeenCalled();
  });

  it('marks a template as one, says what uses it, and offers no star (ADR-0026)', async () => {
    const onOpenTemplates = vi.fn();
    const onMoveToNotes = vi.fn();
    show({
      heading: heading({ kind: 'template', crumb: { icon: 'template', parent: 'Templates' } }),
      template: {
        uses: [{ kind: 'type', typeName: 'task', typeLabel: 'Task' }],
        onOpenTemplates,
        onMoveToNotes,
      },
    });
    const band = screen.getByRole('complementary', { name: 'Template' });
    expect(band.textContent).toContain('Used for: New Task notes');
    expect(screen.queryByRole('button', { name: 'Add A15-03 to favorites' })).toBeNull();
    // Edited as the note it gives: its properties show without asking.
    expect(screen.getByLabelText('estimate')).toBeDefined();
    await userEvent.click(within(band).getByRole('button', { name: 'All templates' }));
    expect(onOpenTemplates).toHaveBeenCalledOnce();
    // A template that was a note all along is one press from being one again.
    await userEvent.click(within(band).getByRole('button', { name: 'Move to notes…' }));
    expect(onMoveToNotes).toHaveBeenCalledOnce();
  });

  it('wears no template band on a note', () => {
    show();
    expect(screen.queryByRole('complementary', { name: 'Template' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add A15-03 to favorites' })).toBeTruthy();
  });

  it('splits from the menu while a split is possible', async () => {
    const onSplit = vi.fn();
    show({ arrangement: { onSplit } });
    await openMenu();
    await userEvent.click(await item(/^Split right/));
    expect(onSplit).toHaveBeenCalled();
    await openMenu();
    expect(screen.queryByRole('menuitem', { name: /^Close pane/ })).toBeNull();
  });

  it('closes from the menu once there is another pane', async () => {
    const onClose = vi.fn();
    show({ arrangement: { onClose } });
    await openMenu();
    expect(screen.queryByRole('menuitem', { name: /^Split right/ })).toBeNull();
    await userEvent.click(await item(/^Close pane/));
    expect(onClose).toHaveBeenCalled();
  });

  it("splits from the bar's own button as well as the menu", async () => {
    const onSplit = vi.fn();
    show({ arrangement: { onSplit } });
    expect(screen.queryByRole('button', { name: 'Close pane' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Split right' }));
    expect(onSplit).toHaveBeenCalledOnce();
  });

  it("closes from the bar's own button as well as the menu", async () => {
    const onClose = vi.fn();
    show({ arrangement: { onClose } });
    expect(screen.queryByRole('button', { name: 'Split right' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Close pane' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('draws the close button on a pane with no note in it', async () => {
    const onClose = vi.fn();
    show({ state: { kind: 'empty' }, heading: null, arrangement: { onClose } });
    await userEvent.click(screen.getByRole('button', { name: 'Close pane' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('still offers splitting in a pane with no note in it', async () => {
    const onSplit = vi.fn();
    show({ state: { kind: 'empty' }, heading: null, arrangement: { onSplit } });
    expect(screen.getByText('Select a note to read it.')).toBeDefined();
    await openMenu();
    await userEvent.click(await item(/^Split right/));
    expect(onSplit).toHaveBeenCalled();
  });

  it('carries the way back to a hidden sidebar only when given one', async () => {
    const onShowSidebar = vi.fn();
    show({ arrangement: { onShowSidebar } });
    await userEvent.click(screen.getByRole('button', { name: 'Show sidebar' }));
    expect(onShowSidebar).toHaveBeenCalled();
  });

  it('has no sidebar button while the sidebar is showing', () => {
    show();
    expect(screen.getByRole('button', { name: 'More' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Show sidebar' })).toBeNull();
  });

  it('reveals the file path on request', async () => {
    show();
    expect(screen.queryByText('tasks/A15-03.md')).toBeNull();
    await openMenu();
    await userEvent.click(await item(/^Reveal file path/));
    expect(screen.getByText('tasks/A15-03.md')).toBeDefined();
  });
});

describe('NotePane: the head', () => {
  it('heads a note with its title as the one level-1 heading of the page', () => {
    show();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('A15-03');
  });

  it('renames the file when the title is the filename', async () => {
    const { onRename, onChangeProperty } = show();
    await userEvent.click(screen.getByRole('button', { name: 'A15-03' }));
    const input = screen.getByRole('textbox', { name: 'Note name' });
    await userEvent.clear(input);
    await userEvent.type(input, 'A15-04{Enter}');
    expect(onRename).toHaveBeenCalledWith('A15-04');
    expect(onChangeProperty).not.toHaveBeenCalled();
  });

  it('edits the title property when that is what heads the page', async () => {
    const { onRename, onChangeProperty } = show({
      heading: heading({ title: { text: 'Leftovers', source: 'property' } }),
    });
    await userEvent.click(screen.getByRole('button', { name: 'Leftovers' }));
    const input = screen.getByRole('textbox', { name: 'Title' });
    await userEvent.type(input, ' again{Enter}');
    expect(onChangeProperty).toHaveBeenCalledWith('title', 'Leftovers again');
    expect(onRename).not.toHaveBeenCalled();
  });

  it('can still rename the file of a note headed by its title, from the menu', async () => {
    const { onRename } = show({
      heading: heading({ title: { text: 'Leftovers', source: 'property' } }),
    });
    await openMenu();
    await userEvent.click(await item(/^Rename file/));
    const input = screen.getByRole('textbox', { name: 'Note name' });
    expect((input as HTMLInputElement).value).toBe('A15-03');
    await userEvent.clear(input);
    await userEvent.type(input, 'A15-09{Enter}');
    expect(onRename).toHaveBeenCalledWith('A15-09');
  });

  it('does not offer to rename the file separately when the title is the filename', async () => {
    show();
    await openMenu();
    await item(/^Reveal file path/);
    expect(screen.queryByRole('menuitem', { name: /^Rename file/ })).toBeNull();
  });

  it('hides the title property when it only repeats the heading', () => {
    show({
      heading: heading({ title: { text: 'Leftovers', source: 'property' } }),
      properties: [
        { def: def('title'), value: 'Leftovers', error: null },
        { def: def('estimate'), value: '3h', error: null },
      ],
    });
    expect(screen.queryByLabelText('title')).toBeNull();
    expect(screen.getByLabelText('estimate')).toBeDefined();
  });

  it('keeps the title property when the heading is the filename', () => {
    show({ properties: [{ def: def('title'), value: 'Something else', error: null }] });
    expect(screen.getByLabelText('title')).toBeDefined();
  });
});

describe('NotePane: a note', () => {
  const plan = createVaultPath('docs/plan.md');
  const task = createVaultPath('tasks/A15-02.md');
  const links: NoteLinks = {
    incoming: [
      { path: plan, title: 'The plan', via: null },
      { path: task, title: 'A15-02', via: 'Project' },
    ],
    outgoing: [{ path: createVaultPath('zed.md'), title: 'Zed', via: null }],
  };

  it('counts its links both ways, collapsed, and opens into the two groups', async () => {
    const { onOpenNote } = show({ links });
    const toggle = screen.getByRole('button', { name: /^Links/ });
    expect(toggle.textContent).toContain('2 linked here · 1 linked from here');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: /The plan/ })).toBeNull();

    await userEvent.click(toggle);
    const here = screen.getByRole('region', { name: 'Links here' });
    expect(within(here).getByRole('button', { name: /A15-02 — Project/ })).toBeDefined();
    const from = screen.getByRole('region', { name: 'Links from this note' });
    expect(within(from).getByRole('button', { name: /Zed/ })).toBeDefined();
    expect(within(from).queryByRole('button', { name: /The plan/ })).toBeNull();

    await userEvent.click(within(here).getByRole('button', { name: /The plan/ }));
    expect(onOpenNote).toHaveBeenCalledWith('docs/plan.md');
  });

  it('heads the notes linking to a person as where they are mentioned', async () => {
    show({ links, typeName: 'person' });
    await userEvent.click(screen.getByRole('button', { name: /^Links/ }));
    const mentioned = screen.getByRole('region', { name: 'Mentioned in' });
    expect(within(mentioned).getByRole('button', { name: /The plan/ })).toBeDefined();
    expect(screen.queryByRole('region', { name: 'Links here' })).toBeNull();
  });

  it('says so when nothing is linked either way', async () => {
    show();
    const toggle = screen.getByRole('button', { name: /^Links/ });
    expect(toggle.textContent).toContain('No links yet');
    await userEvent.click(toggle);
    expect(screen.getByText('Nothing links here yet.')).toBeDefined();
    expect(screen.getByText('This note links nowhere yet.')).toBeDefined();
  });

  it('looks for unlinked mentions only when asked, and links one on request', async () => {
    const props = show({
      mentions: {
        kind: 'ready',
        mentions: [{ path: plan, title: 'The plan', excerpt: 'uses A15-03 daily' }],
      },
    });
    await userEvent.click(screen.getByRole('button', { name: /^Links/ }));
    expect(screen.queryByText('uses A15-03 daily')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Unlinked mentions' }));
    expect(screen.getByText('uses A15-03 daily')).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Link the mention in The plan' }));
    expect(props.onLinkMention).toHaveBeenCalledWith('docs/plan.md');
  });

  it('asks for unlinked mentions the first time the group opens', async () => {
    const props = show();
    await userEvent.click(screen.getByRole('button', { name: /^Links/ }));
    expect(props.onFindMentions).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Unlinked mentions' }));
    expect(props.onFindMentions).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Looking…')).toBeDefined();
  });

  it('says why unlinked mentions could not be linked', async () => {
    show({ mentions: { kind: 'failed', message: 'plan has unsaved changes. Save it first.' } });
    await userEvent.click(screen.getByRole('button', { name: /^Links/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Unlinked mentions' }));
    expect(screen.getByRole('alert').textContent).toBe('plan has unsaved changes. Save it first.');
  });

  it('links a note from the menu, through the picker, into the text', async () => {
    const onChange = vi.fn();
    show({
      onChange,
      suggestNotes: (query) =>
        [
          { path: plan, target: 'plan' },
          { path: task, target: 'A15-02' },
        ].filter((note) => note.target.toLowerCase().includes(query.toLowerCase())),
    });
    await openMenu();
    await userEvent.click(await item(/Link to…/));
    const picker = await screen.findByRole('dialog', { name: 'Link to a note' });
    await userEvent.type(within(picker).getByRole('searchbox'), 'A15');
    expect(within(picker).queryByRole('option', { name: /plan/ })).toBeNull();
    await userEvent.keyboard('{Enter}');

    expect(screen.queryByRole('dialog', { name: 'Link to a note' })).toBeNull();
    const written = JSON.stringify(onChange.mock.calls.at(-1)?.[0]);
    expect(written).toContain('"type":"wikiLink"');
    expect(written).toContain('"target":"A15-02"');
  });

  it('offers Show in graph when the page can be shown there', async () => {
    const onShowInGraph = vi.fn();
    show({ onShowInGraph });
    await openMenu();
    await userEvent.click(await item(/Show in graph/));
    expect(onShowInGraph).toHaveBeenCalled();
  });

  it('offers Export… when the page can be exported (#501)', async () => {
    const onExport = vi.fn();
    show({ onExport });
    await openMenu();
    await userEvent.click(await item(/^Export…$/));
    expect(onExport).toHaveBeenCalled();
  });

  it('shows its properties above the text', () => {
    show();
    expect(screen.getByRole('region', { name: 'Properties' })).toBeDefined();
  });
});

describe('NotePane: a view or a dashboard', () => {
  const dashboard = () =>
    show({
      heading: heading({
        kind: 'dashboard',
        crumb: { icon: 'chart', parent: 'Dashboards' },
        title: { text: 'Progress', source: 'file' },
        description: 'Every task, by phase',
      }),
      properties: [{ def: def('widgets'), value: [{ kind: 'bar' }], error: null }],
      links: {
        incoming: [{ path: createVaultPath('docs/plan.md'), title: 'plan', via: null }],
        outgoing: [],
      },
      body: <p>the widgets</p>,
    });

  it('draws its own body, headed by the breadcrumb with its description beside the name', () => {
    dashboard();
    expect(screen.getByText('the widgets')).toBeDefined();
    expect(screen.getByText('Every task, by phase').closest('.page-bar__count')).not.toBeNull();
    const title = screen.getByRole('heading', { level: 1, name: 'Progress' });
    expect(title.classList.contains('visually-hidden')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Progress' })).toBeNull();
  });

  it('puts its own controls in the bar, not on the page', () => {
    show({
      heading: heading({ kind: 'view' }),
      properties: [],
      body: <p>the board</p>,
      actions: <button type="button">Customize</button>,
    });
    const customize = screen.getByRole('button', { name: 'Customize' });
    expect(customize.closest('.page-bar')).not.toBeNull();
    expect(customize.closest('.page')).toBeNull();
  });

  it('still renames the file from the menu, in a field that then goes away', async () => {
    const { onRename } = show({
      heading: heading({ kind: 'view', title: { text: 'Doing', source: 'property' } }),
      properties: [],
      body: <p>the board</p>,
    });
    await openMenu();
    await userEvent.click(await item(/^Rename file/));
    const input = screen.getByRole('textbox', { name: 'Note name' });
    await userEvent.clear(input);
    await userEvent.type(input, 'Doing now{Enter}');
    expect(onRename).toHaveBeenCalledWith('Doing now');
    expect(screen.queryByRole('textbox', { name: 'Note name' })).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Doing' })).toBeDefined();
  });

  it('keeps its frontmatter and its links out of the page', () => {
    dashboard();
    expect(screen.getByText('the widgets')).toBeDefined();
    expect(screen.queryByRole('region', { name: 'Properties' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Links' })).toBeNull();
  });

  it('shows its frontmatter behind Page properties', async () => {
    dashboard();
    await openMenu();
    await userEvent.click(await item(/^Page properties/));
    expect(
      within(screen.getByRole('region', { name: 'Properties' })).getByText('1 item'),
    ).toBeDefined();
  });

  it('offers the SQL of a view, and not of a dashboard', async () => {
    show({
      heading: heading({ kind: 'view', sql: 'SELECT path FROM notes' }),
      properties: [],
      body: <p>the board</p>,
    });
    await openMenu();
    await userEvent.click(await item(/^Show SQL/));
    expect(screen.getByText('SELECT path FROM notes')).toBeDefined();
  });

  it('has no Show SQL where there is no query', async () => {
    dashboard();
    await openMenu();
    await item(/^Page properties/);
    expect(screen.queryByRole('menuitem', { name: /SQL/ })).toBeNull();
  });
});

describe('NotePane: a source', () => {
  const source = () =>
    show({
      heading: heading({ kind: 'source' }),
      properties: [{ def: def('format'), value: 'json', error: null }],
      body: <p>the feed</p>,
    });

  it('leaves its raw frontmatter to the source card', () => {
    source();
    expect(screen.getByText('the feed')).toBeDefined();
    expect(screen.queryByRole('region', { name: 'Properties' })).toBeNull();
  });

  it('still shows its frontmatter behind Page properties', async () => {
    source();
    await openMenu();
    await userEvent.click(await item(/^Page properties/));
    expect(
      within(screen.getByRole('region', { name: 'Properties' })).getByText('format'),
    ).toBeDefined();
  });
});

describe('NotePane: editing the title commits once, and only when asked', () => {
  it('writes the title property once for one Enter', async () => {
    const { onChangeProperty } = show({
      heading: heading({ title: { text: 'Leftovers', source: 'property' } }),
    });
    await userEvent.click(screen.getByRole('button', { name: 'Leftovers' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Title' }), ' again{Enter}');
    await userEvent.click(document.body);
    expect(onChangeProperty).toHaveBeenCalledTimes(1);
  });

  it('writes nothing when the edit is abandoned with Escape', async () => {
    const { onChangeProperty, onRename } = show({
      heading: heading({ title: { text: 'Leftovers', source: 'property' } }),
    });
    await userEvent.click(screen.getByRole('button', { name: 'Leftovers' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Title' }), ' again{Escape}');
    await userEvent.click(document.body);
    expect(screen.getByRole('button', { name: 'Leftovers' })).toBeDefined();
    expect(onChangeProperty).not.toHaveBeenCalled();
    expect(onRename).not.toHaveBeenCalled();
  });
});

describe('NotePane: adding a property never overwrites one the file already has', () => {
  const addProperty = async (name: string) => {
    await userEvent.click(screen.getByRole('button', { name: 'Add a property' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Property name' }), `${name}{Enter}`);
  };

  it('does not add over the title property that heads the page', async () => {
    const { onAddProperty } = show({
      heading: heading({ title: { text: 'Leftovers', source: 'property' } }),
      properties: [
        { def: def('title'), value: 'Leftovers', error: null },
        { def: def('estimate'), value: '3h', error: null },
      ],
    });
    await addProperty('title');
    expect(onAddProperty).not.toHaveBeenCalled();
  });

  it('does not add over the type of a typed note', async () => {
    // The app never lists `type` as a row — the panel is headed by it — so the
    // rows alone cannot tell the add field that the key is taken.
    const { onAddProperty } = show({ typeName: 'task' });
    await addProperty('type');
    expect(onAddProperty).not.toHaveBeenCalled();
  });

  it('says why "type" cannot be added', async () => {
    show({ typeName: 'task' });
    await userEvent.click(screen.getByRole('button', { name: 'Add a property' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Property name' }), 'type');
    expect(screen.getByRole('alert').textContent).toMatch(/kept for DFAI/);
  });

  it('does not add over a key the file holds that no row shows', async () => {
    const { onAddProperty } = show({ properties: [], propertyKeys: ['query'] });
    await addProperty('query');
    expect(onAddProperty).not.toHaveBeenCalled();
  });

  it('still adds a key the file does not hold', async () => {
    const { onAddProperty } = show({ propertyKeys: ['query'] });
    await addProperty('owner');
    expect(onAddProperty).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ key: 'owner', scope: 'type' }),
    );
  });
});

describe('NotePane: a title property typed on a note headed by its filename', () => {
  /** The app around the pane: a write lands in the file, and the heading is worked out again. */
  function Harness({ record }: { record: (key: string, value: unknown) => void }) {
    const [values, setValues] = useState<Record<string, unknown>>({ estimate: '3h', title: '' });
    const change = (key: string, value: unknown) => {
      record(key, value);
      setValues((was) => {
        const next = { ...was };
        if (value === null) delete next[key];
        else next[key] = value;
        return next;
      });
    };
    return (
      <NotePane
        {...baseProps()}
        heading={heading({ title: pageTitle({ fileTitle: 'A15-03', properties: values }) })}
        properties={Object.entries(values).map(([key, value]) => ({
          def: def(key),
          value,
          error: null,
        }))}
        onChangeProperty={change}
      />
    );
  }

  it('keeps the row, and the focus, for every keystroke', async () => {
    const record = vi.fn();
    render(<Harness record={record} />);
    await userEvent.type(screen.getByLabelText('title'), 'My title');

    expect(record).toHaveBeenLastCalledWith('title', 'My title');
    expect(document.activeElement).toBe(screen.getByLabelText('title'));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('My title');
  });

  it('removes the title property when the heading it supplies is cleared', async () => {
    const onChangeProperty = vi.fn();
    show({
      heading: heading({ title: { text: 'Leftovers', source: 'property' } }),
      properties: [{ def: def('title'), value: 'Leftovers', error: null }],
      onChangeProperty,
    });
    await userEvent.click(screen.getByRole('button', { name: 'Leftovers' }));
    await userEvent.clear(screen.getByRole('textbox', { name: 'Title' }));
    await userEvent.keyboard('{Enter}');
    expect(onChangeProperty).toHaveBeenCalledExactlyOnceWith('title', null);
  });

  it('does not rename the file to nothing when a filename heading is cleared', async () => {
    const { onRename, onChangeProperty } = show();
    await userEvent.click(screen.getByRole('button', { name: 'A15-03' }));
    await userEvent.clear(screen.getByRole('textbox', { name: 'Note name' }));
    await userEvent.keyboard('{Enter}');
    expect(onRename).not.toHaveBeenCalled();
    expect(onChangeProperty).not.toHaveBeenCalled();
  });
});

describe('NotePane: moving and deleting the page', () => {
  it('offers Move to… and Delete… last, and runs them', async () => {
    const onMoveTo = vi.fn();
    const onDelete = vi.fn();
    show({ onMoveTo, onDelete });
    await openMenu();
    const labels = (await screen.findAllByRole('menuitem')).map((each) => each.textContent);
    expect(labels.slice(-2)).toEqual(['Move to…', 'Delete…']);

    await userEvent.click(await item(/^Delete…/));
    expect(onDelete).toHaveBeenCalledTimes(1);
    await openMenu();
    await userEvent.click(await item(/^Move to…/));
    expect(onMoveTo).toHaveBeenCalledTimes(1);
  });

  it('offers neither where the app gives neither — a dashboard cannot be moved', async () => {
    show({ onDelete: vi.fn(), heading: heading({ kind: 'dashboard' }) });
    await openMenu();
    expect(await item(/^Delete…/)).toBeDefined();
    expect(screen.queryByRole('menuitem', { name: /^Move to…/ })).toBeNull();
  });
});

describe('NotePane: images', () => {
  type Saved = { src: string; alt: string };
  const photo = () => new File([new Uint8Array([1, 2, 3])], 'photo.png', { type: 'image/png' });
  const written = (onChange: ReturnType<typeof vi.fn>) =>
    onChange.mock.calls.map((call) => JSON.stringify(call[0]));

  /** A promise and the hands that settle it, so a test can hold an image mid-save. */
  function pending<Value>() {
    let resolve: (value: Value) => void = () => {};
    const promise = new Promise<Value>((yes) => {
      resolve = yes;
    });
    return { promise, resolve };
  }

  async function pick(files: File | File[]) {
    await openMenu();
    await userEvent.click(await item(/^Insert image…/));
    await userEvent.upload(screen.getByLabelText('Choose an image'), files);
  }

  it('offers no image picking where the page takes no images', async () => {
    show();
    await openMenu();
    expect(await item(/^Link to…/)).toBeDefined();
    expect(screen.queryByRole('menuitem', { name: /^Insert image…/ })).toBeNull();
    expect(screen.queryByLabelText('Choose an image')).toBeNull();
  });

  it('puts a picked image into the note once it is saved, with a placeholder until then', async () => {
    const onChange = vi.fn();
    const saving = pending<Saved>();
    const embedImage = vi.fn(() => saving.promise);
    show({ onChange, embedImage });

    await pick(photo());

    expect(embedImage).toHaveBeenCalledWith(expect.objectContaining({ name: 'photo.png' }), 'file');
    expect(screen.getByText('Adding photo.png…')).toBeDefined();
    expect(written(onChange).some((doc) => doc.includes('"type":"image"'))).toBe(false);

    saving.resolve({ src: 'attachments/photo.png', alt: 'photo' });
    await vi.waitFor(() => expect(written(onChange).at(-1)).toContain('"type":"image"'));
    expect(written(onChange).at(-1)).toContain('"src":"attachments/photo.png"');
    expect(written(onChange).at(-1)).toContain('"alt":"photo"');
    expect(screen.queryByText('Adding photo.png…')).toBeNull();
  });

  it('shows why an image could not be saved, puts nothing in the note, and can be dismissed', async () => {
    const onChange = vi.fn();
    const embedImage = vi.fn(async (): Promise<Saved> => {
      throw new Error('“broken.png” could not be read as an image.');
    });
    show({ onChange, embedImage });

    await pick(new File(['x'], 'broken.png', { type: 'image/png' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('“broken.png” could not be read as an image.');
    expect(written(onChange).some((doc) => doc.includes('"type":"image"'))).toBe(false);

    await userEvent.click(within(alert).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/could not be read as an image/)).toBeNull();
  });

  it('writes several picked images in order when they save in order', async () => {
    const onChange = vi.fn();
    const embedImage = vi.fn(async (file: File) => ({ src: file.name, alt: '' }));
    show({ onChange, embedImage });

    await pick(
      ['a', 'b', 'c'].map((name) => new File([name], `${name}.png`, { type: 'image/png' })),
    );

    await vi.waitFor(() => expect(written(onChange).at(-1)).toContain('"src":"c.png"'));
    const last = written(onChange).at(-1) ?? '';
    const at = (name: string) => last.indexOf(`"src":"${name}.png"`);
    expect(at('a')).toBeLessThan(at('b'));
    expect(at('b')).toBeLessThan(at('c'));
  });

  it('writes several picked images in the order they were picked, whatever order they save in', async () => {
    const onChange = vi.fn();
    const first = pending<Saved>();
    const second = pending<Saved>();
    const embedImage = vi
      .fn<(file: File) => Promise<Saved>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    show({ onChange, embedImage });

    await pick([
      new File(['a'], 'a.png', { type: 'image/png' }),
      new File(['b'], 'b.png', { type: 'image/png' }),
    ]);
    second.resolve({ src: 'b.png', alt: '' });
    await vi.waitFor(() => expect(written(onChange).at(-1)).toContain('"src":"b.png"'));
    first.resolve({ src: 'a.png', alt: '' });

    await vi.waitFor(() => {
      const last = written(onChange).at(-1) ?? '';
      expect(last).toContain('"src":"b.png"');
      expect(last).toContain('"src":"a.png"');
    });
    const last = written(onChange).at(-1) ?? '';
    expect(last.indexOf('"src":"a.png"')).toBeLessThan(last.indexOf('"src":"b.png"'));
  });

  it('never silently loses an image saved while the note was re-read from disk', async () => {
    const paragraph = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
    const before = { type: 'doc', content: [paragraph('Before.')] } as unknown as EditorDocument;
    // The other pane saved the note, and this one — clean — re-reads it.
    const reread = {
      type: 'doc',
      content: [paragraph('Before.'), paragraph('Typed in the other pane.')],
    } as unknown as EditorDocument;
    const onChange = vi.fn();
    const saving = pending<Saved>();
    const props: NotePaneProps = {
      ...baseProps(),
      state: ready({ doc: before }),
      onChange,
      embedImage: vi.fn(() => saving.promise),
    };
    const { rerender } = render(<NotePane {...props} />);

    await pick(photo());
    expect(screen.getByText('Adding photo.png…')).toBeDefined();
    rerender(<NotePane {...props} state={ready({ doc: reread })} />);
    saving.resolve({ src: 'attachments/photo.png', alt: 'photo' });

    // The file is in the vault now: the note shows it, or says it could not.
    await vi.waitFor(() => {
      const placed = written(onChange).some((doc) => doc.includes('attachments/photo.png'));
      const told = screen.queryByRole('alert') !== null;
      expect(placed || told).toBe(true);
    });
  });

  /** A note on screen that is re-read from disk while `embedImage` is still saving. */
  async function rereadWhileSaving(saving: Promise<Saved>) {
    const paragraph = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
    const before = { type: 'doc', content: [paragraph('Before.')] } as unknown as EditorDocument;
    const reread = {
      type: 'doc',
      content: [paragraph('Before.'), paragraph('Typed in the other pane.')],
    } as unknown as EditorDocument;
    const onChange = vi.fn();
    const props: NotePaneProps = {
      ...baseProps(),
      state: ready({ doc: before }),
      onChange,
      embedImage: vi.fn(() => saving),
    };
    const { rerender } = render(<NotePane {...props} />);
    await pick(photo());
    rerender(<NotePane {...props} state={ready({ doc: reread })} />);
    return { onChange };
  }

  it('puts an image saved during a re-read at the end of the note, and says so', async () => {
    const saving = pending<Saved>();
    const { onChange } = await rereadWhileSaving(saving.promise);
    saving.resolve({ src: 'attachments/photo.png', alt: 'photo' });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('photo.png was added at the end of the note');
    const last = written(onChange).at(-1) ?? '';
    expect(last.indexOf('Typed in the other pane.')).toBeGreaterThan(-1);
    expect(last.indexOf('attachments/photo.png')).toBeGreaterThan(
      last.indexOf('Typed in the other pane.'),
    );
  });

  it('still says why an image could not be saved when the note was re-read meanwhile', async () => {
    let refuse: (reason: Error) => void = () => {};
    const { onChange } = await rereadWhileSaving(
      new Promise<Saved>((_resolve, reject) => {
        refuse = reject;
      }),
    );
    refuse(new Error('The disk is full.'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The disk is full.');
    expect(written(onChange).some((doc) => doc.includes('photo'))).toBe(false);
  });
});

describe('NotePane: inside the peek', () => {
  const peekProps = (): Partial<NotePaneProps> => ({
    chrome: 'peek',
    properties: [
      { def: def('estimate'), value: '3h', error: null },
      { def: def('phase'), value: null, error: null },
    ],
  });

  it('leaves the bar to the peek: no breadcrumb, no menu, no star', () => {
    show(peekProps());
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
    expect(screen.queryByRole('button', { name: /favou?rite/i })).toBeNull();
  });

  it('keeps the title as the page head, still editable', () => {
    show(peekProps());
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('A15-03');
  });

  it('folds the properties into the strip, "+ N empty" for the empty ones', () => {
    show(peekProps());
    const properties = screen.getByRole('region', { name: 'Properties' });
    expect(within(properties).getByLabelText('estimate')).toBeDefined();
    expect(within(properties).queryByLabelText('phase')).toBeNull();
    expect(screen.getByRole('button', { name: '+ 1 empty' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Add a property' })).toBeNull();
  });

  it('heads a page with its bar and its properties block, as before', () => {
    show({ ...peekProps(), chrome: 'page' });
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toBeDefined();
    expect(screen.queryByRole('button', { name: '+ 1 empty' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add a property' })).toBeDefined();
  });
});
