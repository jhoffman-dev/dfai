import { mountShell } from '@dfai/shell';
import { composeDesktop } from './composition.ts';

mountShell({ ports: composeDesktop() });
