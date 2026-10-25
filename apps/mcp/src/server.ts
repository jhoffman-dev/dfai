/** The MCP server: every DFAI tool, bound to one client. */

import { McpServer } from '@modelcontextprotocol/server';
import mcpPackage from '../package.json' with { type: 'json' };
import type { AtlasClient } from './client.ts';
import { UPLOAD_LIMITS, type UploadLimits } from './upload-limits.ts';
import { archiveTools } from './tools/archive.ts';
import { assistantTools } from './tools/assistant.ts';
import { artifactTools } from './tools/artifacts.ts';
import { automationTools } from './tools/automations.ts';
import { checklistTools } from './tools/checklists.ts';
import { captureTools } from './tools/capture.ts';
import { imageTools } from './tools/images.ts';
import { meetingTools } from './tools/meetings.ts';
import { inboxTools } from './tools/inbox.ts';
import { noteTools } from './tools/notes.ts';
import { peopleTools } from './tools/people.ts';
import { proposalTools } from './tools/proposals.ts';
import { queryTools } from './tools/queries.ts';
import { scheduleTools } from './tools/schedule.ts';
import { reviewTools } from './tools/review.ts';
import { sourceTools } from './tools/sources.ts';
import { tagTools } from './tools/tags.ts';
import { templateTools } from './tools/templates.ts';
import { termTools } from './tools/terms.ts';
import { vaultTools } from './tools/vault.ts';
import { viewTools } from './tools/views.ts';

export const SERVER_NAME = 'dfai';
/** The app's version: `pnpm version:set` keeps this package's in step with it (#481). */
export const SERVER_VERSION = mcpPackage.version;

export const ATLAS_TOOLS = [
  ...vaultTools,
  ...noteTools,
  ...queryTools,
  ...viewTools,
  ...captureTools,
  ...artifactTools,
  ...imageTools,
  ...sourceTools,
  ...tagTools,
  ...peopleTools,
  ...templateTools,
  ...termTools,
  ...archiveTools,
  ...inboxTools,
  ...scheduleTools,
  ...checklistTools,
  ...reviewTools,
  ...automationTools,
  ...meetingTools,
  ...assistantTools,
  ...proposalTools,
];

const INSTRUCTIONS =
  'DFAI is a local notes app; these tools read and write its vault while it is running. ' +
  'Notes are named by vault-relative paths with ".md". Read a note before changing it and pass ' +
  'its "modified" back as "ifModified". Call atlas_list_types before creating typed notes or ' +
  'querying, so property keys and values are real ones.';

export function createAtlasServer(
  client: AtlasClient,
  limits: UploadLimits = UPLOAD_LIMITS,
): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  for (const tool of ATLAS_TOOLS) tool.register(server, client, limits);
  return server;
}
