import { describe, expect, it } from 'vitest';
import { digestOf, type VaultPath } from '@dfai/domain';
import { apiFixture } from '../testing/api-fixture.ts';
import { jsonLinesMarkdown, jsonLinesNote, vaultPath } from '../testing/proposal-vault.ts';
import { acceptProposalNote } from './accept-proposal.ts';
import type { ProposalPorts } from './proposal-file.ts';

/**
 * Adversarial pass on P29-02 (#15): a link proposal names its note as Claude
 * spelled it, and the disk a Mac vault lives on ignores case.
 */

const PROPOSAL = 'Inbox/Proposals/Link Mara.md';
const MARA_PATH = 'People/Mara Quill.md';
const MARA = jsonLinesNote({ type: 'person', companies: ['[[Fenn & Co]]'] }, 'Mara.\n');
const PERSON_TYPE = jsonLinesNote({
  name: 'person',
  properties: { companies: { kind: 'relation', target: 'company', many: true } },
});

/** A case-insensitive vault in memory whose panes know each note by its one, on-disk spelling. */
function caseInsensitiveVault(note: string) {
  const fixture = apiFixture({
    caseInsensitive: true,
    markdown: jsonLinesMarkdown(),
    files: {
      [PROPOSAL]: jsonLinesNote({
        type: 'proposal',
        kind: 'link',
        payload: {
          note,
          property: 'companies',
          link: '[[Larkspur Payroll]]',
          digest: digestOf(MARA),
        },
      }),
      [MARA_PATH]: MARA,
      '.atlas/types/person.md': PERSON_TYPE,
    },
  });
  const dirty = new Set<string>();
  const reloaded: VaultPath[] = [];
  const panes = fixture.deps.movingNotes;
  const ports: ProposalPorts = {
    fs: fixture.fs,
    index: fixture.deps.index,
    markdown: jsonLinesMarkdown(),
    editors: {
      ...panes,
      // As the app's registry does: a pane holds a note by the path it opened it at.
      state: (path) => (dirty.has(path) ? 'dirty' : panes.state(path)),
      reload: (path) => void reloaded.push(path),
    },
  };
  return { fixture, ports, dirty, reloaded };
}

describe('acceptProposalNote — a link whose note is spelled in another case', () => {
  it('refuses while the note has unsaved typing, however the proposal cases its path', async () => {
    const setup = caseInsensitiveVault('people/mara quill.md');
    setup.dirty.add(MARA_PATH);

    await expect(
      acceptProposalNote({
        via: 'app',
        ports: setup.ports,
        path: vaultPath(PROPOSAL),
        today: '2026-10-08',
      }),
    ).rejects.toThrow(/unsaved typing/);
    expect(setup.fixture.files.get(MARA_PATH)?.text).toBe(MARA);
  });

  it('reloads the pane that shows the note it changed', async () => {
    const setup = caseInsensitiveVault('people/mara quill.md');
    await acceptProposalNote({
      via: 'app',
      ports: setup.ports,
      path: vaultPath(PROPOSAL),
      today: '2026-10-08',
    });

    expect(setup.fixture.files.get(MARA_PATH)?.text).toContain('Larkspur Payroll');
    expect(setup.reloaded).toContain(MARA_PATH);
  });
});
