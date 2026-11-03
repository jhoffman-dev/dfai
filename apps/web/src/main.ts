import { mountShell } from '@dfai/shell';
import { composeWebShell } from './composition.ts';
import { gitHubWebVault, signOutOfDevice, webDevice, type WebSession } from './github-vault.ts';
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
