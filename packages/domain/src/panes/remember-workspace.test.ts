import { describe, expect, it } from 'vitest';
import { createVaultPath } from '../vault/vault-path.ts';
import { HISTORY_LIMIT, type NavigationPlace } from './navigation-history.ts';
import {
  parseRememberedWorkspace,
  rememberWorkspace,
  WORKSPACE_FORMAT_VERSION,
} from './remember-workspace.ts';
import {
  closeTab,
  EMPTY_WORKSPACE,
  openInActiveTab,
  openInNewTab,
  pinTab,
  splitWithTab,
  tabPlace,
  type Workspace,
  MAX_PANES,
} from './workspace.ts';

const VAULT = 'vault:larkspur';
const acme: NavigationPlace = { kind: 'note', path: createVaultPath('Acme.md') };
const beta: NavigationPlace = { kind: 'note', path: createVaultPath('Beta.md') };

/** Every kind of place, so the format is seen to carry each one. */
const EVERY_PLACE: readonly NavigationPlace[] = [
  acme,
  { kind: 'type', name: 'task' },
  { kind: 'graph', scope: { kind: 'vault' } },
  { kind: 'graph', scope: { kind: 'note', path: createVaultPath('Acme.md'), depth: 2 } },
  { kind: 'query' },
  { kind: 'tags', tag: null },
  { kind: 'tags', tag: 'urgent' },
  { kind: 'archive' },
  { kind: 'inbox' },
  { kind: 'review' },
  { kind: 'today' },
  { kind: 'automations' },
  { kind: 'activity' },
  { kind: 'templates' },
  { kind: 'document', path: createVaultPath('Library/The Lantern Keepers.pdf') },
  { kind: 'terms' },
  { kind: 'skills' },
  { kind: 'ask' },
];

function remembered(workspace: Workspace, vaultKey = VAULT): unknown {
  return JSON.parse(JSON.stringify(rememberWorkspace({ workspace, vaultKey })));
}

describe('rememberWorkspace', () => {
  it('writes a versioned record against the vault, holding every pane and tab', () => {
    const ws = splitWithTab(openInNewTab(openInActiveTab(EMPTY_WORKSPACE, acme), beta));
    expect(rememberWorkspace({ workspace: ws, vaultKey: VAULT })).toEqual({
      version: WORKSPACE_FORMAT_VERSION,
      vault: VAULT,
      focused: 1,
      nextId: 4,
      panes: [
        {
          active: 't2',
          tabs: [
            { id: 't1', pinned: false, history: { back: [], current: acme, forward: [] } },
            { id: 't2', pinned: false, history: { back: [], current: beta, forward: [] } },
          ],
        },
        {
          active: 't3',
          tabs: [{ id: 't3', pinned: false, history: { back: [], current: beta, forward: [] } }],
        },
      ],
    });
  });

  it('leaves the closed stack out: a closed tab does not outlive the window', () => {
    const ws = closeTab(openInNewTab(openInActiveTab(EMPTY_WORKSPACE, acme), beta), {
      pane: 0,
      id: 't2',
    });
    expect(ws.closed).toHaveLength(1);
    expect(JSON.stringify(rememberWorkspace({ workspace: ws, vaultKey: VAULT }))).not.toContain(
      'closed',
    );
  });
});

describe('parseRememberedWorkspace', () => {
  it('reads back what was written, through JSON, for every kind of place', () => {
    let ws = EMPTY_WORKSPACE;
    for (const place of EVERY_PLACE) ws = openInNewTab(ws, place);
    ws = openInActiveTab(ws, beta);
    const read = parseRememberedWorkspace(remembered(ws), VAULT);
    expect(read).not.toBeNull();
    expect(read!.panes).toEqual(ws.panes);
    expect(read!.focused).toBe(ws.focused);
  });

  it('starts the closed stack empty and keeps the next id, so a closed tab’s id is never minted again', () => {
    const ws = closeTab(openInNewTab(openInActiveTab(EMPTY_WORKSPACE, acme), beta), {
      pane: 0,
      id: 't2',
    });
    const read = parseRememberedWorkspace(remembered(ws), VAULT)!;
    expect(read.closed).toEqual([]);
    expect(read.nextId).toBe(3);
    expect(openInNewTab(read, beta).panes[0]!.tabs.map((tab) => tab.id)).toEqual(['t1', 't3']);
  });

  it('moves the next id past the ids read when the stored one is behind them', () => {
    const record = {
      ...(remembered(openInNewTab(openInActiveTab(EMPTY_WORKSPACE, acme), beta)) as object),
      nextId: 1,
    };
    expect(parseRememberedWorkspace(record, VAULT)!.nextId).toBe(3);
    expect(parseRememberedWorkspace({ ...record, nextId: 'many' }, VAULT)!.nextId).toBe(3);
  });

  it('is nothing remembered for a different vault: the paths are not there', () => {
    const ws = openInActiveTab(EMPTY_WORKSPACE, acme);
    expect(parseRememberedWorkspace(remembered(ws), 'vault:other')).toBeNull();
  });

  it('is nothing remembered for anything that is not a record', () => {
    for (const junk of [null, undefined, 'tabs', 7, [], true]) {
      expect(parseRememberedWorkspace(junk, VAULT)).toBeNull();
    }
  });

  it('is nothing remembered for a version it does not know', () => {
    const record = remembered(openInActiveTab(EMPTY_WORKSPACE, acme)) as { version: number };
    expect(parseRememberedWorkspace({ ...record, version: 2 }, VAULT)).toBeNull();
    expect(parseRememberedWorkspace({ ...record, version: '1' }, VAULT)).toBeNull();
  });

  it('is nothing remembered when no pane survives', () => {
    expect(parseRememberedWorkspace({ version: 1, vault: VAULT, panes: [] }, VAULT)).toBeNull();
    expect(
      parseRememberedWorkspace({ version: 1, vault: VAULT, panes: [{ tabs: [] }, 7] }, VAULT),
    ).toBeNull();
    expect(parseRememberedWorkspace({ version: 1, vault: VAULT, panes: 'no' }, VAULT)).toBeNull();
  });

  it('drops a tab whose place does not parse, and the pane if none is left', () => {
    const read = parseRememberedWorkspace(
      {
        version: 1,
        vault: VAULT,
        focused: 1,
        panes: [
          {
            active: 't1',
            tabs: [
              { id: 't1', pinned: false, history: { back: [], current: acme, forward: [] } },
              { id: 't2', pinned: false, history: 'none' },
              'not a tab',
              { pinned: false, history: { back: [], current: acme, forward: [] } },
            ],
          },
          { active: 't3', tabs: [{ id: 't3', pinned: false }] },
        ],
      },
      VAULT,
    )!;
    expect(read.panes).toHaveLength(1);
    expect(read.panes[0]!.tabs.map((tab) => tab.id)).toEqual(['t1']);
    expect(read.focused).toBe(0);
  });

  it('drops a place it cannot read, wherever it sits in a history', () => {
    const read = parseRememberedWorkspace(
      {
        version: 1,
        vault: VAULT,
        panes: [
          {
            active: 't1',
            tabs: [
              {
                id: 't1',
                pinned: false,
                history: {
                  back: [
                    acme,
                    { kind: 'note', path: '/absolute.md' },
                    { kind: 'note' },
                    { kind: 'type', name: '' },
                    { kind: 'graph', scope: { kind: 'note', path: 'Acme.md', depth: 3 } },
                    { kind: 'graph', scope: { kind: 'sun' } },
                    { kind: 'tags', tag: 4 },
                    { kind: 'peek' },
                    null,
                  ],
                  current: { kind: 'note', path: '' },
                  forward: [{ kind: 'today', extra: 'dropped' }, 'no'],
                },
              },
            ],
          },
        ],
      },
      VAULT,
    )!;
    const tab = read.panes[0]!.tabs[0]!;
    expect(tab.history.back).toEqual([acme]);
    expect(tab.history.current).toBeNull();
    expect(tab.history.forward).toEqual([{ kind: 'today' }]);
  });

  it('reads a history with missing or wrong parts as what is left of it', () => {
    const read = parseRememberedWorkspace(
      {
        version: 1,
        vault: VAULT,
        panes: [
          {
            active: 't1',
            tabs: [{ id: 't1', pinned: 'yes', history: { back: 'no', current: acme } }],
          },
        ],
      },
      VAULT,
    )!;
    const tab = read.panes[0]!.tabs[0]!;
    expect(tab.history).toEqual({ back: [], current: acme, forward: [] });
    expect(tab.pinned).toBe(false);
  });

  it(`keeps a history to ${HISTORY_LIMIT} places, as the app does`, () => {
    const back = Array.from({ length: HISTORY_LIMIT + 7 }, (_, n) => ({
      kind: 'tags',
      tag: `t${n}`,
    }));
    const read = parseRememberedWorkspace(
      {
        version: 1,
        vault: VAULT,
        panes: [
          { active: 't1', tabs: [{ id: 't1', pinned: false, history: { back, current: acme } }] },
        ],
      },
      VAULT,
    )!;
    expect(read.panes[0]!.tabs[0]!.history.back).toHaveLength(HISTORY_LIMIT);
    expect(read.panes[0]!.tabs[0]!.history.back[0]).toEqual({ kind: 'tags', tag: 't7' });
  });

  it('drops a tab whose id another tab already has, so ids stay unique', () => {
    const read = parseRememberedWorkspace(
      {
        version: 1,
        vault: VAULT,
        panes: [
          {
            active: 't1',
            tabs: [
              { id: 't1', pinned: false, history: { back: [], current: acme, forward: [] } },
              { id: 't1', pinned: false, history: { back: [], current: beta, forward: [] } },
            ],
          },
          {
            active: 't1',
            tabs: [{ id: 't1', pinned: false, history: { back: [], current: beta, forward: [] } }],
          },
        ],
      },
      VAULT,
    )!;
    expect(read.panes).toHaveLength(1);
    expect(read.panes[0]!.tabs).toHaveLength(1);
  });

  it('shows the first tab when the active id names none of them', () => {
    const read = parseRememberedWorkspace(
      {
        version: 1,
        vault: VAULT,
        panes: [
          {
            active: 't9',
            tabs: [
              { id: 't1', pinned: false, history: { back: [], current: acme, forward: [] } },
              { id: 't2', pinned: false, history: { back: [], current: beta, forward: [] } },
            ],
          },
        ],
      },
      VAULT,
    )!;
    expect(read.panes[0]!.active).toBe('t1');
  });

  it('puts pinned tabs first, however they were stored', () => {
    const read = parseRememberedWorkspace(
      {
        version: 1,
        vault: VAULT,
        panes: [
          {
            active: 't1',
            tabs: [
              { id: 't1', pinned: false, history: { back: [], current: acme, forward: [] } },
              { id: 't2', pinned: true, history: { back: [], current: beta, forward: [] } },
            ],
          },
        ],
      },
      VAULT,
    )!;
    expect(read.panes[0]!.tabs.map((tab) => tab.id)).toEqual(['t2', 't1']);
    expect(
      parseRememberedWorkspace(
        remembered(
          pinTab(openInNewTab(openInActiveTab(EMPTY_WORKSPACE, acme), beta), { pane: 0, id: 't2' }),
        ),
        VAULT,
      )!.panes[0]!.tabs.map((tab) => tab.pinned),
    ).toEqual([true, false]);
  });

  it(`keeps at most ${MAX_PANES} panes and a focus that names one of them`, () => {
    const pane = (id: string) => ({
      active: id,
      tabs: [{ id, pinned: false, history: { back: [], current: acme, forward: [] } }],
    });
    const read = parseRememberedWorkspace(
      { version: 1, vault: VAULT, focused: 2, panes: [pane('t1'), pane('t2'), pane('t3')] },
      VAULT,
    )!;
    expect(read.panes).toHaveLength(MAX_PANES);
    expect(read.focused).toBe(0);
    expect(
      parseRememberedWorkspace(
        { version: 1, vault: VAULT, focused: 1.5, panes: [pane('t1'), pane('t2')] },
        VAULT,
      )!.focused,
    ).toBe(0);
    expect(
      parseRememberedWorkspace(
        { version: 1, vault: VAULT, focused: 1, panes: [pane('t1'), pane('t2')] },
        VAULT,
      )!.focused,
    ).toBe(1);
  });

  it('keeps an id that is not of its own making, which nothing it mints can repeat', () => {
    const read = parseRememberedWorkspace(
      {
        version: 1,
        vault: VAULT,
        panes: [
          {
            active: 'left',
            tabs: [
              { id: 'left', pinned: false, history: { back: [], current: acme, forward: [] } },
              { id: 't12', pinned: false, history: { back: [], current: beta, forward: [] } },
            ],
          },
        ],
      },
      VAULT,
    )!;
    expect(read.panes[0]!.tabs.map((tab) => tab.id)).toEqual(['left', 't12']);
    expect(read.panes[0]!.active).toBe('left');
    expect(read.nextId).toBe(13);
    expect(openInNewTab(read, acme).panes[0]!.tabs.map((tab) => tab.id)).toEqual([
      'left',
      't13',
      't12',
    ]);
  });

  it('mints afresh an id past what a number counts, so no later id can repeat it', () => {
    const tab = (id: string) => ({ id, pinned: false, history: { back: [], current: acme } });
    const read = parseRememberedWorkspace(
      {
        version: 1,
        vault: VAULT,
        nextId: 20,
        panes: [
          {
            active: 't9007199254740992',
            tabs: [
              tab('t9007199254740992'),
              tab(`t${'9'.repeat(400)}`),
              tab('t9007199254740991'),
              tab('t12'),
            ],
          },
        ],
      },
      VAULT,
    )!;
    expect(read.panes[0]!.tabs.map((tab) => tab.id)).toEqual(['t20', 't21', 't22', 't12']);
    expect(read.panes[0]!.active).toBe('t20');
    expect(read.nextId).toBe(23);
    const unsafeNext = { ...(remembered(EMPTY_WORKSPACE) as object), nextId: 2 ** 60 };
    expect(parseRememberedWorkspace(unsafeNext, VAULT)!.nextId).toBe(2);
  });

  describe('the old split format', () => {
    it('upgrades to one tab per pane, on the note the pane held', () => {
      const read = parseRememberedWorkspace(
        { vault: VAULT, paths: ['Acme.md', 'Beta.md'], focused: 1 },
        VAULT,
      )!;
      expect(read.panes.map((pane) => pane.tabs.map((tab) => tabPlace(tab)))).toEqual([
        [acme],
        [beta],
      ]);
      expect(read.focused).toBe(1);
      expect(read.panes.map((pane) => pane.active)).toEqual(['t1', 't2']);
      expect(read.nextId).toBe(3);
      expect(read.closed).toEqual([]);
    });

    it('upgrades an empty pane to an empty tab, with nothing to go back to', () => {
      const read = parseRememberedWorkspace({ vault: VAULT, paths: [null], focused: 0 }, VAULT)!;
      expect(read.panes[0]!.tabs[0]!.history).toEqual({ back: [], current: null, forward: [] });
    });

    it('is nothing remembered for another vault, or a split with no panes', () => {
      expect(
        parseRememberedWorkspace({ vault: 'vault:other', paths: ['Acme.md'], focused: 0 }, VAULT),
      ).toBeNull();
      expect(parseRememberedWorkspace({ vault: VAULT, paths: [], focused: 0 }, VAULT)).toBeNull();
    });

    it('reads anything that is not a split as nothing, rather than as an error', () => {
      expect(parseRememberedWorkspace('{}', VAULT)).toBeNull();
      expect(parseRememberedWorkspace({ vault: VAULT }, VAULT)).toBeNull();
    });

    it('drops a path that could escape the vault, leaving that pane an empty tab', () => {
      const read = parseRememberedWorkspace(
        { vault: VAULT, paths: ['../secrets.md', 'Acme.md'], focused: 0 },
        VAULT,
      )!;
      expect(read.panes.map((pane) => tabPlace(pane.tabs[0]!))).toEqual([null, acme]);
    });

    it(`keeps no more than ${MAX_PANES} panes, and the focus falls back when its pane was dropped`, () => {
      const read = parseRememberedWorkspace(
        { vault: VAULT, paths: ['Acme.md', 'Beta.md', 'Gamma.md'], focused: 2 },
        VAULT,
      )!;
      expect(read.panes).toHaveLength(MAX_PANES);
      expect(read.focused).toBe(0);
    });

    it('falls back to the first pane when the remembered focus is nonsense', () => {
      const read = parseRememberedWorkspace(
        { vault: VAULT, paths: ['Acme.md'], focused: 'second' },
        VAULT,
      )!;
      expect(read.focused).toBe(0);
    });
  });
});
