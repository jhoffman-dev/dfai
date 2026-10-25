/**
 * How a tool is declared: a name, words for the model, an input schema, and
 * the one API call it makes. Registration and error reporting live here so
 * every tool reports failure the same way.
 */

import type { CallToolResult, McpServer, ToolAnnotations } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import { AtlasCallError, type AtlasClient } from '../client.ts';
import type { UploadLimits } from '../upload-limits.ts';

export interface ToolSpec<Input extends z.ZodObject> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Input;
  readonly annotations: ToolAnnotations;
  /** The single REST call this tool is. Its answer is returned to the model as JSON. */
  readonly call: (
    client: AtlasClient,
    input: z.infer<Input>,
    limits: UploadLimits,
  ) => Promise<unknown>;
}

/** A tool bound to its types, ready to be added to a server. */
export interface AtlasTool {
  readonly name: string;
  readonly register: (server: McpServer, client: AtlasClient, limits: UploadLimits) => void;
}

export function defineTool<Input extends z.ZodObject>(spec: ToolSpec<Input>): AtlasTool {
  return {
    name: spec.name,
    register: (server, client, limits) => {
      const { title, description, annotations } = spec;
      // Widened for the SDK, whose conditional types cannot see through a generic schema.
      // The SDK validates every call against this schema first, so `input` is its output.
      const inputSchema: z.ZodObject = spec.inputSchema;
      server.registerTool(
        spec.name,
        { title, description, inputSchema, annotations: { openWorldHint: false, ...annotations } },
        (input) => runCall(() => spec.call(client, input as z.infer<Input>, limits)),
      );
    },
  };
}

async function runCall(call: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(await call(), null, 2) }] };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: failureMessage(error) }] };
  }
}

function failureMessage(error: unknown): string {
  if (error instanceof AtlasCallError) return error.message;
  // Unexpected: logged in full to stderr for whoever runs the server, never sent as a stack.
  console.error(error);
  return `DFAI MCP server error: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * Drops keys whose value is `undefined`, so optional tool inputs become the
 * contract's optional fields rather than fields explicitly set to nothing.
 */
export function definedOnly<T extends object>(value: T): DefinedOnly<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as DefinedOnly<T>;
}

type DefinedOnly<T> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};
