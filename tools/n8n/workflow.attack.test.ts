import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NODES } from './workflow.ts';

/*
 * PR #86 (issue #80): the failure notification. The README wires the DFAI
 * branch beside the Notion branch and above it, so n8n's v1 order runs DFAI
 * — and its notification — before Notion writes anything.
 */

interface WorkflowNode {
  readonly name: string;
  readonly parameters: Record<string, unknown>;
}

const committed = JSON.parse(
  readFileSync(new URL('meeting-to-atlas.workflow.json', import.meta.url), 'utf8'),
) as { nodes: readonly WorkflowNode[] };

describe('the failure email', () => {
  it('does not tell you Notion has the meeting, which it has not written yet', () => {
    const notify = committed.nodes.find((each) => each.name === NODES.notify);
    const message = String(notify?.parameters.message ?? '');
    expect(message).toContain('$json.error');
    expect(message).not.toMatch(/is in Notion/i);
  });

  it('cannot be given a forged line by a meeting’s title, source id or error', () => {
    const notify = committed.nodes.find((each) => each.name === NODES.notify);
    const forged = 'Retro\r\nSource ID: forged\u2028Execution: none';
    const forging = () => ({ item: { json: { title: forged, sourceId: `id\nMeeting: forged` } } });
    const render = (template: string, $: (name: string) => unknown = forging) =>
      template
        .replace(/^=/, '')
        .replace(/\{\{ ([\s\S]+?) \}\}/g, (_, expression: string) =>
          String(
            new Function('$', '$json', '$workflow', '$execution', `return (${expression});`)(
              $,
              { error: 'GitHub said\n409' },
              { name: 'Meeting to DFAI' },
              { id: '7' },
            ),
          ),
        );
    const lines = render(String(notify?.parameters.message)).split('\n');
    expect(lines).toEqual([
      'This meeting did not reach DFAI: GitHub said 409',
      '',
      'Meeting: Retro Source ID: forged Execution: none',
      'Source ID: id Meeting: forged',
      'Execution: Meeting to DFAI #7',
    ]);
    expect(render(String(notify?.parameters.subject))).toBe(
      'DFAI did not get a meeting: Retro Source ID: forged Execution: none',
    );
    // A node that never ran leaves its value empty; the email still goes.
    const neverRan = () => {
      throw new Error('node has not run');
    };
    expect(render(String(notify?.parameters.message), neverRan).split('\n').slice(2, 4)).toEqual([
      'Meeting: ',
      'Source ID: ',
    ]);
  });
});
