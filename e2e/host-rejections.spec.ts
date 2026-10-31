import { expect, test } from './fixtures.ts';
import { createVault, installHost } from './host.ts';

/*
 * The real host's `invoke` rejects with whatever a command's `Err` serialized
 * to — Tauri's `ipc-protocol.js` hands the parsed response body straight to the
 * error callback — so a `Result<_, String>` command rejects with a bare string,
 * never an `Error`. The adapters branch on that (`throughHost` turns a string
 * into a `VaultAccessError` and passes an `Error` through as it is), so a stub
 * that rejected with an `Error` let a spec pass down a branch the app never takes.
 */
test('the stub host rejects with the string a command returned, as Tauri does', async ({
  page,
}) => {
  const vault = await createVault();
  await vault.write('Kept.md', '# Kept\n');
  await installHost(page, vault);
  await page.goto('/');

  const rejections = await page.evaluate(async (root) => {
    const { invoke } = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (
            c: string,
            a?: unknown,
            o?: { headers: Record<string, string> },
          ) => Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__;
    const rejectionOf = (call: Promise<unknown>) =>
      call.then(
        () => ({ type: 'resolved', isError: false, value: null as unknown }),
        (rejection: unknown) => ({
          type: typeof rejection,
          isError: rejection instanceof Error,
          value: rejection,
        }),
      );
    const beforeOpen = await rejectionOf(
      invoke('list_vault_files', { extension: 'md', skipDirectories: [], maxDepth: 4 }),
    );
    // A raw body goes the other way through the stub, as `write_binary_file` sends it.
    const rawBeforeOpen = await rejectionOf(
      invoke('write_binary_file', new Uint8Array([1, 2, 3]), {
        headers: { 'atlas-path': 'Drop.bin', 'atlas-offset': '0' },
      }),
    );
    // A command whose `Err` is a struct rejects with the object it serialized to.
    const structured = await rejectionOf(
      invoke('kindle_fetch_notebook', { url: 'https://read.example.com/notebook' }),
    );
    await invoke('open_vault', { location: { absolutePath: root } });
    const staleTrash = await rejectionOf(
      invoke('trash_entry', {
        path: 'Kept.md',
        unchanged: [{ path: 'Kept.md', modified: 0, digest: 'not the digest' }],
      }),
    );
    const escaping = await rejectionOf(invoke('read_text_file', { path: '../outside.md' }));
    return { beforeOpen, rawBeforeOpen, structured, staleTrash, escaping };
  }, vault.root);

  const refusedWith = (value: unknown) => ({ type: typeof value, isError: false, value });
  expect(rejections.beforeOpen).toEqual(refusedWith('no vault is open'));
  expect(rejections.rawBeforeOpen).toEqual(refusedWith('no vault is open'));
  expect(rejections.structured).toEqual(
    refusedWith({ kind: 'not_connected', message: 'Kindle is not connected' }),
  );
  expect(rejections.staleTrash).toEqual(
    refusedWith('a file changed on disk since it was read, so nothing was moved to the Trash'),
  );
  expect(rejections.escaping).toEqual(refusedWith('path escapes the vault'));
});

/*
 * A command the stub has no answer for is a gap in the stub, not a refusal the
 * app should be seen to handle: the test fails, with the stub's stack, even
 * when the page carries on as if a refusal came back.
 */
test('a command the stub host has no answer for fails the test', async ({ page }) => {
  test.fail(true, 'an unstubbed command must fail the test it happens in');
  const vault = await createVault();
  await installHost(page, vault);
  await page.goto('/');
  const rejected = await page.evaluate(() =>
    (
      window as unknown as {
        __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> };
      }
    ).__TAURI_INTERNALS__
      .invoke('no_such_command', {})
      .then(
        () => false,
        () => true,
      ),
  );
  // The page saw a refusal and nothing here fails; only the stub's own record can.
  expect(rejected).toBe(true);
});

/*
 * `report_error` (`lib.rs`) logs what the page caught and answers nothing, so
 * a stub that had no answer for it failed every test where WebKit reported a
 * ResizeObserver loop. The stub keeps what was reported for a spec to read.
 */
test('the stub host takes a reported error as the real one does: answered, and kept', async ({
  page,
}) => {
  const vault = await createVault();
  const host = await installHost(page, vault);
  await page.goto('/');
  const answered = await page.evaluate(() =>
    (
      window as unknown as {
        __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> };
      }
    ).__TAURI_INTERNALS__.invoke('report_error', { message: 'Larkspur failed to load @ app.js:1' }),
  );
  expect(answered).toBeNull();
  expect(host.reportedErrors()).toContain('Larkspur failed to load @ app.js:1');
});
