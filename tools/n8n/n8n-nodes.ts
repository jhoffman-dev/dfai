/*
 * n8n node shapes both workflows draw with (workflow.ts, granola-webhook.workflow.ts).
 * Key order is kept: the JSON is committed, and a reordered key is a diff.
 */

export type Position = [number, number];

/** Failures leave by the node's second output (to "DFAI commit failed") instead of stopping the run. */
export const ERROR_OUTPUT = { onError: 'continueErrorOutput' } as const;

export const to = (...names: string[]) => names.map((node) => ({ node, type: 'main', index: 0 }));

export interface CodeNodeSpec {
  readonly name: string;
  readonly id: string;
  readonly jsCode: string;
  readonly position: Position;
  /** One run per item (the default), or one for all, which may `await` n8n's helpers. */
  readonly mode?: 'runOnceForEachItem' | 'runOnceForAllItems';
}

export function codeNode({ name, id, jsCode, position, mode }: CodeNodeSpec) {
  return {
    id,
    name,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position,
    parameters: { mode: mode ?? 'runOnceForEachItem', jsCode },
    ...ERROR_OUTPUT,
  };
}

/** A node that does nothing, where a branch ends. */
export function endNode(name: string, id: string, position: Position) {
  return { id, name, type: 'n8n-nodes-base.noOp', typeVersion: 1, position, parameters: {} };
}

export interface IfNodeSpec {
  readonly name: string;
  readonly id: string;
  readonly position: Position;
  /** The condition's own id. */
  readonly conditionId: string;
  readonly leftValue: string;
  readonly rightValue: string | number;
  readonly operator: Readonly<Record<string, unknown>>;
}

/** An If node with one condition: true leaves by the first output, false by the second. */
export function ifNode({
  name,
  id,
  position,
  conditionId,
  leftValue,
  rightValue,
  operator,
}: IfNodeSpec) {
  return {
    id,
    name,
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    position,
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{ id: conditionId, leftValue, rightValue, operator }],
        combinator: 'and',
      },
      options: {},
    },
  };
}
