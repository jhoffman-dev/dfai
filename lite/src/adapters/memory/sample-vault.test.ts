import { openVault, VaultSession } from '../../application/index.ts';
import { sampleNoteStore } from './index.ts';

describe('the sample vault', () => {
  it('opens with its notes, a favourite, links that resolve and one that does not yet', async () => {
    const session = new VaultSession();
    const opened = await openVault({ store: sampleNoteStore(), session });
    expect(opened).toEqual({ noteCount: 12, favoritesProblem: null });
    expect(session.favorites).toContain('Projects/Larkspur Payroll.md');
    expect(session.index.backlinks('People/Mara Quill.md').length).toBeGreaterThan(2);
    expect(session.index.unresolved().map((target) => target.target)).toEqual(['Materials list']);
    expect(session.index.notesWithTag('not-a-tag')).toEqual([]);
  });
});
