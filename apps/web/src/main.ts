import { signOutAndForget } from '@dfai/application';
import { mountShell } from '@dfai/shell';
import { composeWebShell } from './composition.ts';
import {
  askToLoseSaves,
  forgettingDevice,
  gitHubWebVault,
  unsentSaves,
  webDevice,
} from './github-vault.ts';
import { startWeb } from './start-web.tsx';
import { composeWebAuth } from './web-auth.ts';

// Signed in with GitHub first (#663), then the GitHub vault through this device's cache (#667).
const auth = composeWebAuth();
const device = webDevice(window);
let session: ReturnType<typeof gitHubWebVault> | null = null;

function mountApp(): () => void {
  const vault = gitHubWebVault({ auth, device });
  session = vault;
  const unmount = mountShell(composeWebShell(vault.ports));
  return () => {
    vault.stop();
    unmount();
  };
}

/**
 * Asks first while saves wait (#667), and stays signed in, with them, on a
 * no. The session stops keeping before anything is forgotten, so nothing it
 * read lands after.
 */
async function signOut(): Promise<void> {
  await signOutAndForget({
    unsent: () => unsentSaves(device),
    confirmLosing: askToLoseSaves(window),
    signOut: async () => {
      session?.stop();
      await auth.signOut();
    },
    forget: forgettingDevice(device),
  });
}

startWeb({
  auth,
  mountApp,
  signOut,
  vaultOnDevice: () => device.remembered.read() !== null,
}).catch(reportError);
