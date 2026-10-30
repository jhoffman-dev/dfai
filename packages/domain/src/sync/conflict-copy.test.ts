import { describe, expect, it } from 'vitest';
import {
  conflictCopyPath,
  hasConflictMarkers,
  isConflictCopyPath,
  macLabel,
  planConflictSteps,
  settingsFileOfCopy,
} from './conflict-copy.ts';

const none = new Set<string>();

describe('conflictCopyPath', () => {
  it('saves the other Mac’s version beside the note, named for that Mac', () => {
    expect(conflictCopyPath({ path: 'Projects/Ideas.md', mac: 'Work Mac', taken: none })).toBe(
      'Projects/Ideas (conflict from Work Mac).md',
    );
  });

  it('keeps an attachment’s extension', () => {
    expect(conflictCopyPath({ path: 'Attachments/photo.png', mac: 'Laptop', taken: none })).toBe(
      'Attachments/photo (conflict from Laptop).png',
    );
  });

  it('numbers the copy when the name is taken, ignoring case as macOS does', () => {
    const taken = new Set(['ideas (conflict from Laptop).md', 'Ideas (conflict from Laptop) 2.md']);
    expect(conflictCopyPath({ path: 'Ideas.md', mac: 'Laptop', taken })).toBe(
      'Ideas (conflict from Laptop) 3.md',
    );
  });

  it('treats a leading dot as part of the name, not an extension', () => {
    expect(conflictCopyPath({ path: '.gitignore', mac: 'Laptop', taken: none })).toBe(
      '.gitignore (conflict from Laptop)',
    );
  });

  it('puts copies of DFAI’s own files where they cannot become a second rule or view', () => {
    expect(
      conflictCopyPath({ path: '.atlas/automations/Tidy.md', mac: 'Laptop', taken: none }),
    ).toBe('Sync conflicts/atlas/automations/Tidy (conflict from Laptop).md');
    expect(conflictCopyPath({ path: '.atlas/settings.md', mac: 'Laptop', taken: none })).toBe(
      'Sync conflicts/atlas/settings (conflict from Laptop).md',
    );
  });

  it('keeps a Mac’s name from reaching into another folder', () => {
    expect(conflictCopyPath({ path: 'a.md', mac: 'Evil/../Mac', taken: none })).toBe(
      'a (conflict from Evil-..-Mac).md',
    );
  });
});

describe('hasConflictMarkers', () => {
  it('knows the markers git writes, and nothing else', () => {
    expect(hasConflictMarkers('<<<<<<< HEAD\na\n=======\nb\n>>>>>>> origin/main\n')).toBe(true);
    expect(hasConflictMarkers('a note that quotes <<<<<<< HEAD inline\n')).toBe(false);
    expect(hasConflictMarkers('<<<<<<< HEAD\nonly the start\n')).toBe(false);
  });
});

describe('macLabel', () => {
  it('says another Mac when the name is empty', () => {
    expect(macLabel('  ')).toBe('another Mac');
    expect(macLabel('James’s MacBook Pro')).toBe('James’s MacBook Pro');
  });
});

describe('planConflictSteps', () => {
  it('copies theirs for files both Macs changed, and keeps whichever side still has the file otherwise', () => {
    const steps = planConflictSteps({
      conflicts: [
        { path: 'Ideas.md', code: 'UU' },
        { path: 'New.md', code: 'AA' },
        { path: 'Edited here.md', code: 'UD' },
        { path: 'Added here.md', code: 'AU' },
        { path: 'Edited there.md', code: 'DU' },
        { path: 'Added there.md', code: 'UA' },
        { path: 'Gone.md', code: 'DD' },
      ],
      mac: 'Laptop',
      existing: new Set(['Ideas.md']),
    });
    expect(steps).toEqual([
      { kind: 'copy-theirs', path: 'Ideas.md', copy: 'Ideas (conflict from Laptop).md' },
      { kind: 'copy-theirs', path: 'New.md', copy: 'New (conflict from Laptop).md' },
      { kind: 'keep', side: 'ours', path: 'Edited here.md' },
      { kind: 'keep', side: 'ours', path: 'Added here.md' },
      { kind: 'keep', side: 'theirs', path: 'Edited there.md' },
      { kind: 'keep', side: 'theirs', path: 'Added there.md' },
      { kind: 'drop', path: 'Gone.md' },
    ]);
  });

  it('never gives two copies, or a copy and an existing file, the same name', () => {
    const steps = planConflictSteps({
      conflicts: [
        { path: 'Ideas.md', code: 'UU' },
        { path: 'Ideas (conflict from Laptop).md', code: 'UU' },
      ],
      mac: 'Laptop',
      existing: new Set(['Ideas.md', 'Ideas (conflict from Laptop).md']),
    });
    const copies = steps.map((step) => (step.kind === 'copy-theirs' ? step.copy : null));
    expect(copies).toEqual([
      'Ideas (conflict from Laptop) 2.md',
      'Ideas (conflict from Laptop) (conflict from Laptop).md',
    ]);
    expect(new Set(copies).size).toBe(2);
  });
});

describe('isConflictCopyPath', () => {
  it('knows every name conflictCopyPath gives', () => {
    const taken = new Set<string>();
    for (const path of ['Inbox/Meetings/2026-10-06 Standup.md', 'Notes/Plan.md', 'README']) {
      const first = conflictCopyPath({ path, mac: 'Tobias’s Mac', taken });
      taken.add(first);
      const second = conflictCopyPath({ path, mac: 'Tobias’s Mac', taken });
      expect([isConflictCopyPath(first), isConflictCopyPath(second)]).toEqual([true, true]);
    }
  });

  it('is not a name that only looks a little like one', () => {
    expect(isConflictCopyPath('Inbox/Meetings/2026-10-06 Standup.md')).toBe(false);
    expect(isConflictCopyPath('Inbox/Meetings/2026-10-06 Standup (gemini 1a2b3c4d).md')).toBe(
      false,
    );
    expect(isConflictCopyPath('Notes/Conflict from Mara.md')).toBe(false);
    expect(isConflictCopyPath('Notes (conflict from Mara)/Plan.md')).toBe(false);
  });
});

describe('settingsFileOfCopy (#235)', () => {
  it('is the `.atlas/` file a copy under `Sync conflicts/atlas/` was made of, numbered or not', () => {
    for (const mac of ['Laptop', 'Tobias’s Mac', 'Studio (work)']) {
      const taken = new Set<string>();
      const first = conflictCopyPath({ path: '.atlas/types/meeting.md', mac, taken });
      taken.add(first);
      const second = conflictCopyPath({ path: '.atlas/types/meeting.md', mac, taken });
      expect([settingsFileOfCopy(first), settingsFileOfCopy(second)]).toEqual([
        '.atlas/types/meeting.md',
        '.atlas/types/meeting.md',
      ]);
    }
    expect(
      settingsFileOfCopy(
        'Sync conflicts/atlas/migrations/type-properties (conflict from Laptop).md',
      ),
    ).toBe('.atlas/migrations/type-properties.md');
    expect(settingsFileOfCopy('Sync conflicts/atlas/settings (conflict from Studio).MD')).toBe(
      '.atlas/settings.MD',
    );
  });

  it('is null for a copy of a copy: its live file is the first copy, a person’s to settle', () => {
    expect(
      settingsFileOfCopy(
        'Sync conflicts/atlas/types/meeting (conflict from Laptop) (conflict from Studio).md',
      ),
    ).toBeNull();
    expect(
      settingsFileOfCopy(
        'Sync conflicts/atlas/types/meeting (conflict from Laptop) 2 (conflict from Studio).md',
      ),
    ).toBeNull();
  });

  it('is null for anything that is not a markdown copy under `Sync conflicts/atlas/`', () => {
    for (const path of [
      'Notes/Plan (conflict from Laptop).md',
      '.atlas/types/meeting (conflict from Laptop).md',
      'Sync conflicts/atlas/types/meeting.md',
      'Sync conflicts/atlas/attachments/logo (conflict from Laptop).png',
      'Sync conflicts/atlas/ (conflict from Laptop).md',
      'Sync conflicts/notes/Plan (conflict from Laptop).md',
      'sync conflicts/atlas/types/meeting (conflict from Laptop).md',
      'Sync conflicts/atlas/types/meeting (conflict from Laptop) 0.md',
      'Sync conflicts/atlas/types (conflict from Laptop)/meeting.md',
    ]) {
      expect(settingsFileOfCopy(path), path).toBeNull();
    }
  });
});
