import { mountShell } from '@dfai/shell';
import { composeWebShell } from './composition.ts';
import { gitHubWebVault, signOutOfDevice, webDevice, type WebSession } from './github-vault.ts';
import { startWeb } from './start-web.tsx';
import { composeWebAuth } from './web-auth.ts';

// Signed in with GitHub first (#663), then the GitHub vault through this device's cache (#667).
const auth = composeWebAuth();
const device = webDevice(window);
let session: WebSession | null = null;

function mountApp(): () => void {
  const vault = gitHubWebVault({ auth, device });
  session = vault;
  const unmount = mountShell(composeWebShell(vault.ports, vault.closing));
  return () => {
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
