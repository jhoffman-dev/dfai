// Writes meeting-to-atlas.workflow.json: the n8n nodes, with the mapper
// (tools/n8n/*.ts) compiled into their Code nodes. Run `pnpm n8n:build`
// after changing the mapper; a test fails while the JSON is stale.
import './ts-hooks.mjs';
import { writeFile } from 'node:fs/promises';
import prettier from 'prettier';

const { mapMeetingScript, sameMeetingScript, sameMeetingAtOtherPathScript } =
  await import('./code-node.ts');
const { meetingWorkflow } = await import('./workflow.ts');

const target = new URL('meeting-to-atlas.workflow.json', import.meta.url);
const workflow = meetingWorkflow({
  map: mapMeetingScript(),
  same: sameMeetingScript(),
  sameOther: sameMeetingAtOtherPathScript(),
});
const { bundleCaptureMarkdown, CAPTURE_MARKDOWN_BUNDLE } = await import('./capture-bundle.ts');
await writeFile(CAPTURE_MARKDOWN_BUNDLE, await bundleCaptureMarkdown());
console.log(`Wrote ${CAPTURE_MARKDOWN_BUNDLE.pathname}`);

const config = await prettier.resolveConfig(target);
const text = await prettier.format(JSON.stringify(workflow), { ...config, parser: 'json' });
await writeFile(target, text);
console.log(`Wrote ${target.pathname}`);
