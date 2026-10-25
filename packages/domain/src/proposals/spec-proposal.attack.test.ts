/**
 * Adversarial tests for dashboard and view proposals (P32-05, PR #549): specs
 * the checker lets through that do not become what was asked for, or cannot
 * be written at Accept. Fictional types only.
 */
import { describe, expect, it } from 'vitest';
import { parseObjectType } from '../types/property-def.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import { applySpecProposal, checkSpec } from './spec-proposal.ts';

const TYPES = [
  parseObjectType({
    name: 'task',
    label: 'Task',
    properties: { status: { kind: 'select', options: ['inbox', 'done'] }, due: 'date' },
  }),
];
const MAX_FILE_NAME_BYTES = 255;
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

function checked(spec: Record<string, unknown>) {
  const reading = checkSpec(spec, { types: TYPES });
  if (!reading.ok) throw new Error(`refused: ${JSON.stringify(reading.problems)}`);
  return reading.checked;
}

describe('a dashboard spec under attack', () => {
  it('numbers past a taken name with a file name that still fits the disk', () => {
    // 'é' is two bytes: 126 of them plus ".md" is 255 bytes, the most a name may be.
    const name = 'é'.repeat(126);
    const spec = checked({ kind: 'dashboard', name, widgets: [{ kind: 'number', type: 'task' }] });

    const applied = applySpecProposal(spec, {
      types: TYPES,
      takenPaths: [createVaultPath(`.atlas/dashboards/${name}.md`)],
    });

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const fileName = applied.writes[0]!.path.split('/').pop()!;
    expect(bytes(fileName)).toBeLessThanOrEqual(MAX_FILE_NAME_BYTES);
  });

  it('refuses a widget filter it cannot read rather than drop it and count every note', () => {
    const reading = checkSpec(
      {
        kind: 'dashboard',
        name: 'Open work',
        widgets: [
          {
            kind: 'number',
            type: 'task',
            // A misspelt operator: dropped silently, the tile counts done tasks too.
            filters: [{ key: 'status', operator: 'is-not', value: 'done' }],
          },
        ],
      },
      { types: TYPES },
    );

    expect(reading.ok).toBe(false);
  });

  it('refuses widget filters that are not a list rather than drop them', () => {
    const reading = checkSpec(
      {
        kind: 'dashboard',
        name: 'Open work',
        widgets: [{ kind: 'number', type: 'task', filters: 'status != done' }],
      },
      { types: TYPES },
    );

    expect(reading.ok).toBe(false);
  });
});
