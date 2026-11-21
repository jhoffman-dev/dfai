import { describe, expect, it } from 'vitest';
import { createVaultPath } from '../vault/vault-path.ts';
import { assistRowIntegrity } from './assist-apply.ts';
import { assistRecheck } from './assist-recheck.ts';
import { KEPT_PATH, KEPT_TASK, preview, recheckOf } from './assist-recheck.test-support.ts';

/**
 * #911 review: a due date counts only as a word of the person's own prose,
 * and a real day still ahead (item 8); and a row is applied only when it,
 * its evidence and their digests belong together (item 4).
 */

const due = (text: string, day = '2026-12-01') =>
  assistRecheck(recheckOf(preview({ title: 'Renew it', text, answer: { due: day } })));
const asked = (checked: ReturnType<typeof assistRecheck>) =>
  checked.kind === 'ask' ? checked.ask : 'apply';

describe('a due date is a word of the item’s own prose', () => {
  it('counts a day written on its own, before punctuation or in brackets', () => {
    for (const text of [
      'Renew it by 2026-12-01.\n',
      'Renew it (2026-12-01)\n',
      'Due: 2026-12-01, please\n',
    ]) {
      expect(asked(due(text)), text).toBe('apply');
    }
  });

  it('never counts a day inside a URL, a path, a link target or a longer run', () => {
    for (const text of [
      'See https://example.com/2026-12-01/notes\n',
      'Saved under Notes/2026-12-01/agenda.md\n',
      'See [[2026-12-01]] for it.\n',
      'Ticket 2026-12-01-7 was filed.\n',
      'Ref 12026-12-01 in the ledger.\n',
      'Ref x2026-12-01 in the ledger.\n',
    ]) {
      expect(asked(due(text)), text).toBe('due-unconfirmed');
    }
  });

  it('asks for a day that is no day, or one that has passed', () => {
    expect(asked(due('Renew it by 2027-02-30.\n', '2027-02-30'))).toBe('due-unconfirmed');
    expect(asked(due('Renew it by 2026-11-01.\n', '2026-11-01'))).not.toBe('apply');
  });
});

describe('assistRowIntegrity', () => {
  const task = () => preview({ title: 'Call Mara', text: 'Call Mara.\n' });
  const copy = () =>
    preview({
      title: 'Renew Larkspur contract',
      text: '',
      answer: { duplicateOf: KEPT_PATH },
      tasks: [KEPT_TASK],
    });

  it('passes a row and the evidence the preview kept for it', () => {
    expect(assistRowIntegrity(task().row, task().evidence)).toBeNull();
    expect(assistRowIntegrity(copy().row, copy().evidence)).toBeNull();
  });

  it('refuses evidence of another item', () => {
    const other = preview({ title: 'Other', text: 'x\n' });
    expect(assistRowIntegrity(task().row, other.evidence)).toMatch(/another item/u);
  });

  it('refuses an answer that is for another item', () => {
    const { row, evidence } = task();
    const answer = { ...evidence.answer, item: createVaultPath('Inbox/Other.md') };
    expect(assistRowIntegrity(row, { ...evidence, answer })).toMatch(/another item/u);
  });

  it('refuses a digest that is missing or no digest', () => {
    const { row, evidence } = task();
    for (const digest of ['', 'not a digest', '0a1b2c3']) {
      expect(assistRowIntegrity(row, { ...evidence, digest }), digest).toMatch(/digest/u);
    }
    const { row: dup, evidence: kept } = copy();
    expect(assistRowIntegrity(dup, { ...kept, kept: null })).toMatch(/digest/u);
    expect(
      assistRowIntegrity(dup, {
        ...kept,
        kept: { path: createVaultPath('Tasks/Other.md'), digest: '0a1b2c3d' },
      }),
    ).toMatch(/digest/u);
  });

  it('refuses a path outside the vault or not as the vault writes it', () => {
    const { row, evidence } = task();
    for (const path of [
      'Inbox/../People/Mara.md',
      '/Inbox/Call Mara.md',
      'Inbox//Call Mara.md',
      'Inbox/./Call Mara.md',
    ]) {
      const bent = { ...row, path: path as never };
      const item = { ...evidence.item, path: path as never };
      const answer = { ...evidence.answer, item: path as never };
      expect(assistRowIntegrity(bent, { ...evidence, item, answer }), path).toMatch(/path/u);
    }
    const project = { path: '../outside.md' as never, title: 'Outside' };
    const filed = { ...row, step: { kind: 'file' as const, project } };
    expect(assistRowIntegrity(filed, evidence)).toMatch(/path/u);
  });

  it('refuses a duplicate whose copy is not an Inbox item', () => {
    const { row, evidence } = copy();
    const path = createVaultPath('Tasks/Renew Larkspur contract copy.md');
    const moved = { ...row, path };
    const item = { ...evidence.item, path, task: null };
    expect(
      assistRowIntegrity(moved, { ...evidence, item, answer: { ...evidence.answer, item: path } }),
    ).toMatch(/Inbox/u);
  });

  it('refuses a question', () => {
    const junk = preview({ title: 'Junk', text: 'Buy\n', answer: { kind: 'junk' } });
    expect(assistRowIntegrity(junk.row, junk.evidence)).toMatch(/question/u);
  });
});
