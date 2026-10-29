// Writes the n8n workflows: meeting-to-atlas.workflow.json (Gemini's emails),
// granola-webhook.workflow.json (Granola's webhooks) and
// slack-capture.workflow.json with its Slack app manifest, with the mappers
// (tools/n8n/*.ts) compiled into their Code nodes. Run `pnpm n8n:build`
// after changing a mapper; a test fails while a JSON is stale.
import './ts-hooks.mjs';
import { writeFile } from 'node:fs/promises';
import prettier from 'prettier';

const { mapMeetingScript, sameMeetingScript, sameMeetingAtOtherPathScript } =
  await import('./code-node.ts');
const { mapGranolaScript, verifyGranolaScript } = await import('./granola-code-node.ts');
const { meetingWorkflow } = await import('./workflow.ts');
const { granolaWebhookWorkflow } = await import('./granola-webhook.workflow.ts');
const { slackScripts } = await import('./slack-code-node.ts');
const { slackCaptureWorkflow } = await import('./slack-capture.workflow.ts');
const { slackAppManifest } = await import('./slack-app-manifest.ts');

const { bundleCaptureMarkdown, CAPTURE_MARKDOWN_BUNDLE } = await import('./capture-bundle.ts');
await writeFile(CAPTURE_MARKDOWN_BUNDLE, await bundleCaptureMarkdown());
console.log(`Wrote ${CAPTURE_MARKDOWN_BUNDLE.pathname}`);

const github = { same: sameMeetingScript(), sameOther: sameMeetingAtOtherPathScript() };

async function write(file, workflow) {
  const target = new URL(file, import.meta.url);
  const config = await prettier.resolveConfig(target);
  const text = await prettier.format(JSON.stringify(workflow), { ...config, parser: 'json' });
  await writeFile(target, text);
  console.log(`Wrote ${target.pathname}`);
}

await write(
  'meeting-to-atlas.workflow.json',
  meetingWorkflow({ map: mapMeetingScript(), ...github }),
);
await write(
  'granola-webhook.workflow.json',
  granolaWebhookWorkflow({ verify: verifyGranolaScript(), map: mapGranolaScript(), ...github }),
);
await write('slack-capture.workflow.json', slackCaptureWorkflow(slackScripts()));
await write('slack-app.manifest.json', slackAppManifest());
