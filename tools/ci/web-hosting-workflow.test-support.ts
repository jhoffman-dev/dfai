import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * The committed deploy workflow, and ways to change one thing in it, for the
 * workflow checker's tests: each case is the real workflow with one edit, so
 * the checker's answer names that edit and nothing else.
 */

export const WORKFLOW = readFileSync(
  join(import.meta.dirname, '..', '..', '.github/workflows/web-hosting.yml'),
  'utf8',
);

export const KEY_EXPRESSION = '${{ secrets.FIREBASE_SERVICE_ACCOUNT_DAILYFLOWAI_APP }}';

/** The workflow with `from` (which must occur exactly `count` times) replaced. */
export function edited(from: string, to: string, count = 1, text = WORKFLOW): string {
  const found = text.split(from).length - 1;
  if (found !== count)
    throw new Error(`expected ${count} of ${JSON.stringify(from)}, found ${found}`);
  return text.split(from).join(to);
}

/** The workflow's live job's deploy step, or its check step, by their unique neighbours. */
export const LIVE_CHECK =
  '        run: pnpm exec vitest run tools/ci/web-hosting.test.ts\n\n      - name: Deploy live\n';
export const PREVIEW_DEPLOY_USES =
  "      - name: Deploy a preview channel\n        if: steps.key.outputs.set == 'true'\n        uses: FirebaseExtended/action-hosting-deploy@500ac625ca2dd40cbd15f7659af953801858032a # v0.11.0\n";

/** The workflow with one more job, its body given at job indentation (4 spaces). */
export const withJob = (name: string, body: string, text = WORKFLOW) =>
  `${text.trimEnd()}\n\n  ${name}:\n    runs-on: ubuntu-latest\n${body}`;

/** The workflow with one more job that runs `command`. */
export const withRun = (command: string) =>
  withJob('extra', `    steps:\n      - run: ${command}\n`);
