import { resolve } from 'node:path';
import { expect, test } from './fixtures.ts';
import { isIntendedRefusal } from './stub-bugs.ts';

/*
 * Attack on PR #645. Node's own argument checks throw a `TypeError` that
 * carries a string `code` (`ERR_INVALID_ARG_TYPE`), so `isIntendedRefusal`
 * takes it for a file error passed on as the host would. It is the crash a
 * stub makes when it reads an argument under the wrong name: `containedPath`
 * (every read, write, move and trash) resolves `args.path`, `args.from`,
 * `args.to` — undefined when the key is misspelt on either side — and
 * `git_folder_on_disk` hands `args.folder` to `realpath`. The page is given
 * Node's message as a bare-string refusal and the test carries on green,
 * where stub-bugs.ts promises "a `TypeError` in a stub" fails it.
 */
test('a TypeError Node throws for a stub argument that is missing is a stub bug, not a refusal', () => {
  test.fail(true, 'PR #645: a coded Node TypeError counts as an intended refusal');
  let thrown: unknown = null;
  try {
    // What `containedPath(root, args.from)` does when the move's `from` is not there.
    resolve('/vault', (undefined as unknown as { from: string } | undefined)?.from as string);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(TypeError);
  expect(isIntendedRefusal(thrown)).toBe(false);
});
