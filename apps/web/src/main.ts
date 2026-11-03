import { mountShell } from '@dfai/shell';
import { composeWebShell } from './composition.ts';
import { gitHubWebVault, signOutOfDevice, webDevice, type WebSession } from './github-vault.ts';
import { registerShellWorker } from './pwa/register.ts';
import { reloadForUpdate } from './pwa/reload-for-update.ts';
import { showUpdateReady } from './pwa/show-update-ready.tsx';
import { startWeb } from './start-web.tsx';
import { writeWhenHidden } from './web-closing.ts';
import { composeWebAuth } from './web-auth.ts';

// Signed in with GitHub first (#663), then the GitHub vault through this device's cache (#667).
const auth = composeWebAuth();
const device = webDevice(window);
let session: WebSession | null = null;

function mountApp({ freshSignIn }: { freshSignIn: boolean }): () => void {
  const vault = gitHubWebVault({ auth, device, freshSignIn });
  session = vault;
  const unmount = mountShell(composeWebShell(vault.ports, vault.closing));
  // A tab closed or put away in the autosave's wait: what the panes hold is written to the queue.
  const stopWriting = writeWhenHidden(window, vault.closing);
  return () => {
    stopWriting();
    vault.stop();
    unmount();
  };
}

/** Asks first while saves wait (#667), and stays signed in, with them, on a no. */
async function signOut(): Promise<void> {
  if (session !== null) await signOutOfDevice({ auth, device, session });
}

startWeb({
  auth,
  mountApp,
  signOut,
  vaultOnDevice: () => device.remembered.read() !== null,
}).catch(reportError);

// Installed to the Home Screen (#668): the shell is kept for opening offline, and a deploy is offered.
// Only a build writes the worker; a browser without one leaves the app as it is.
if (__DFAI_WEB_BUILD__ && 'serviceWorker' in navigator) {
  registerShellWorker({
    workers: navigator.serviceWorker,
    onUpdateReady: ({ takeOver }) =>
      showUpdateReady(window, () =>
        reloadForUpdate({
          writeAutosave: () => session?.closing.close() ?? Promise.resolve([]),
          lock: device.queueLock,
          takeOver,
          reloadPage: () => window.location.reload(),
          wait: (ms) => new Promise((done) => window.setTimeout(done, ms)),
          report: reportError,
        }).catch(reportError),
      ),
  }).catch(reportError);
}
