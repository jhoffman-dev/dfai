// Writes the n8n workflows: meeting-to-atlas.workflow.json (Gemini's emails)
// and granola-webhook.workflow.json (Granola's webhooks), with the mapper
// (tools/n8n/*.ts) compiled into their Code nodes. Run `pnpm n8n:build`
// after changing the mapper; a test fails while either JSON is stale.
import './ts-hooks.mjs';
import { writeFile } from 'node:fs/promises';
import prettier from 'prettier';

const { mapMeetingScript, sameMeetingScript, sameMeetingAtOtherPathScript } =
  await import('./code-node.ts');
const { mapGranolaScript, verifyGranolaScript } = await import('./granola-code-node.ts');
const { meetingWorkflow } = await import('./workflow.ts');
const { granolaWebhookWorkflow } = await import('./granola-webhook.workflow.ts');

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
