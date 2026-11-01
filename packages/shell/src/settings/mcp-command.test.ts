import { describe, expect, it } from 'vitest';
import { MCP_ENTRY_PLACEHOLDER, mcpAddCommand } from './mcp-command.ts';

describe('the MCP command', () => {
  it('points Claude Code at the server this app was built beside', () => {
    expect(mcpAddCommand('/Users/j/atlas/apps/mcp/dist/main.js')).toEqual({
      command: 'claude mcp add atlas -- node /Users/j/atlas/apps/mcp/dist/main.js',
      placeholder: false,
    });
  });

  it('quotes a path the shell would split', () => {
    expect(mcpAddCommand('/Users/j/My Projects/atlas/main.js').command).toBe(
      "claude mcp add atlas -- node '/Users/j/My Projects/atlas/main.js'",
    );
  });

  it("keeps a quote inside the path from ending the shell's quoting", () => {
    expect(mcpAddCommand("/Users/j/James's/main.js").command).toBe(
      "claude mcp add atlas -- node '/Users/j/James'\\''s/main.js'",
    );
  });

  it("says so when it only knows the README's placeholder", () => {
    expect(mcpAddCommand(null)).toEqual({
      command: `claude mcp add atlas -- node ${MCP_ENTRY_PLACEHOLDER}`,
      placeholder: true,
    });
  });
});
