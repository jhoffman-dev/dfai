import { resolve } from 'node:path';
import { expect, test } from './fixtures.ts';
import { readFile } from 'node:fs/promises';
import { isIntendedRefusal, recordStubBug, stubBugOf } from './stub-bugs.ts';

/*
 * Attack on PR #645. Node's own argument checks throw a `TypeError` that
 * carries a string `code` (`ERR_INVALID_ARG_TYPE`), and `isIntendedRefusal`
 * once took it for a file error passed on as the host would. It is the crash a
 * stub makes when it reads an argument under the wrong name: `containedPath`
 * (every read, write, move and trash) resolves `args.path`, `args.from`,
 * `args.to` — undefined when the key is misspelt on either side — and
 * `git_folder_on_disk` hands `args.folder` to `realpath`. The page was given
 * Node's message as a bare-string refusal and the test carried on green,
 * where stub-bugs.ts promises "a `TypeError` in a stub" fails it.
 */
test('a TypeError Node throws for a stub argument that is missing is a stub bug, not a refusal', () => {
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

test('a file error Node throws stays a refusal, as the host passes its `Err` on', async () => {
  const missing = await readFile('/vault-that-is-not-there/Note.md').catch(
    (error: unknown) => error,
  );
  expect((missing as { code?: unknown }).code).toBe('ENOENT');
  expect(isIntendedRefusal(missing)).toBe(true);
  expect(isIntendedRefusal(new Error('no vault is open'))).toBe(true);
  expect(isIntendedRefusal('a bare refusal')).toBe(true);
  expect(isIntendedRefusal(new RangeError('out of range'))).toBe(false);
});

test('a value a stub throws that is not an Error is recorded as what it was', () => {
  const bug = stubBugOf({ kind: 'oops', at: 3 });
  expect(bug.message).toBe('a stub threw a value that is not an Error: {"kind":"oops","at":3}');
  const loop: { self?: unknown } = {};
  loop.self = loop;
  expect(stubBugOf(loop).message).toBe(
    'a stub threw a value that is not an Error: object JSON cannot describe',
  );
});

test.describe('a stub bug made in a beforeAll', () => {
  test.beforeAll(() => recordStubBug(new TypeError('made before any test ran')));

  test('fails the test after it rather than being dropped', () => {
    test.fail(true, 'the beforeAll bug must be reported by the next test');
  });
});
