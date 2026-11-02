import { describe, expect, it } from 'vitest';
import { conflictCopyPath } from './conflict-copy.ts';
import { copyOfRefusedWrite, deviceOfCommit, WEB_COMMIT_AUTHOR, WEB_DEVICE } from './web-device.ts';

const none = new Set<string>();

describe('copyOfRefusedWrite', () => {
  it('keeps the refused version whole, beside the note, named as a desktop conflict copy is', () => {
    const copy = copyOfRefusedWrite({
      path: 'Projects/Ideas.md',
      device: WEB_DEVICE,
      mine: '# Ideas\n\nmine\n',
      newer: '# Ideas\n\ntheirs\n',
      taken: none,
    });
    expect(copy).toEqual({
      path: 'Projects/Ideas (conflict from DFAI web).md',
      contents: '# Ideas\n\nmine\n',
    });
    // One naming rule for both: the desktop's own, given the web as the device.
    expect(copy?.path).toBe(
      conflictCopyPath({ path: 'Projects/Ideas.md', mac: WEB_DEVICE, taken: none }),
    );
  });

  it('numbers the copy past names already taken, as the desktop does', () => {
    const taken = new Set(['Ideas (conflict from DFAI web).md']);
    expect(
      copyOfRefusedWrite({ path: 'Ideas.md', device: WEB_DEVICE, mine: 'a', newer: 'b', taken })
        ?.path,
    ).toBe('Ideas (conflict from DFAI web) 2.md');
  });

  it('makes no copy when the refused version is already the newer one', () => {
    expect(
      copyOfRefusedWrite({
        path: 'Ideas.md',
        device: WEB_DEVICE,
        mine: 'same',
        newer: 'same',
        taken: none,
      }),
    ).toBeNull();
  });

  it('puts the refused version back at its own path when the note is gone', () => {
    expect(
      copyOfRefusedWrite({
        path: 'Ideas.md',
        device: WEB_DEVICE,
        mine: 'mine',
        newer: null,
        taken: none,
      }),
    ).toEqual({ path: 'Ideas.md', contents: 'mine' });
  });

  it('keeps a gone note as a copy beside whatever now holds its name, folded as macOS folds it', () => {
    for (const there of ['plan.md', 'Plan.md', 'PLAN.MD'])
      expect(
        copyOfRefusedWrite({
          path: 'Plan.md',
          device: WEB_DEVICE,
          mine: 'mine',
          newer: null,
          taken: new Set([there]),
        }),
      ).toEqual({ path: 'Plan (conflict from DFAI web).md', contents: 'mine' });
  });

  it('names web commits for the web, as the desktop names its own for the Mac', () => {
    expect(WEB_COMMIT_AUTHOR.name).toBe('DFAI web');
    expect(WEB_COMMIT_AUTHOR.email).toMatch(/^dfai@[a-z]+\.local$/);
  });
});

describe('deviceOfCommit', () => {
  it('names the Mac a DFAI sync came from, whoever authored it', () => {
    expect(
      deviceOfCommit({ subject: 'DFAI sync from Studio 2026-09-28 13:00', author: 'Mara' }),
    ).toBe('Studio');
  });

  it('names the web for a commit the web authored', () => {
    expect(deviceOfCommit({ subject: 'Save Plan.md', author: 'DFAI web\n' })).toBe(WEB_DEVICE);
  });

  it('names nothing for a commit DFAI did not make', () => {
    expect(deviceOfCommit({ subject: 'Save Plan.md', author: 'Mara Quill' })).toBeNull();
  });
});
