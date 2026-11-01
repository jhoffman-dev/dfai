import { mountShell } from '@dfai/shell';
import { composeWeb } from './composition.ts';
import { startWeb } from './start-web.tsx';
import { composeWebAuth } from './web-auth.ts';

// Signed in with GitHub first (#663); the vault stays the session's sample until #664.
startWeb({ auth: composeWebAuth(), mountApp: () => mountShell({ ports: composeWeb() }) }).catch(
  reportError,
);
