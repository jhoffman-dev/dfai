import { mountShell } from '@dfai/shell';
import { composeDesktopShell } from './composition.ts';

mountShell(composeDesktopShell());
