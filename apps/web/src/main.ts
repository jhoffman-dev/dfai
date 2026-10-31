import { mountShell } from '@dfai/shell';
import { composeWeb } from './composition.ts';

mountShell({ ports: composeWeb() });
