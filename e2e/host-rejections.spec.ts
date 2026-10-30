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
        __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> };
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
    await invoke('open_vault', { location: { absolutePath: root } });
    const staleTrash = await rejectionOf(
      invoke('trash_entry', {
        path: 'Kept.md',
        unchanged: [{ path: 'Kept.md', modified: 0, digest: 'not the digest' }],
      }),
    );
    const escaping = await rejectionOf(invoke('read_text_file', { path: '../outside.md' }));
    return { beforeOpen, staleTrash, escaping };
  }, vault.root);

  expect(rejections.beforeOpen).toEqual({
    type: 'string',
    isError: false,
    value: 'no vault is open',
  });
  expect(rejections.staleTrash).toEqual({
    type: 'string',
    isError: false,
    value: 'a file changed on disk since it was read, so nothing was moved to the Trash',
  });
  expect(rejections.escaping).toEqual({
    type: 'string',
    isError: false,
    value: 'path escapes the vault',
  });
});
