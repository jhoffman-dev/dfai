import { mountShell } from '@dfai/shell';
import { composeWebShell } from './composition.ts';

mountShell(composeWebShell());
