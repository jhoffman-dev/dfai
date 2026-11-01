/** What `apps/mcp/README.md` shows, for a build that does not know where it was made. */
export const MCP_ENTRY_PLACEHOLDER = '/abs/path/to/atlas/apps/mcp/dist/main.js';

/** The Claude Code command that adds the DFAI MCP server, ready to paste into a terminal. */
export interface McpCommand {
  readonly command: string;
  /** True when the path is the README's placeholder and has to be replaced by hand. */
  readonly placeholder: boolean;
}

/**
 * `claude mcp add` for the MCP server at `entry` — the checkout this app was
 * built from, which is only known to a build made from source.
 */
export function mcpAddCommand(entry: string | null): McpCommand {
  return {
    command: `claude mcp add atlas -- node ${shellQuoted(entry ?? MCP_ENTRY_PLACEHOLDER)}`,
    placeholder: entry === null,
  };
}

/** A path as one shell word: left bare when that is safe, single-quoted when not. */
function shellQuoted(path: string): string {
  if (/^[\w@%+=:,./-]+$/.test(path)) return path;
  return `'${path.replaceAll("'", `'\\''`)}'`;
}
