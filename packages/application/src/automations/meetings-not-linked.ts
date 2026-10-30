import {
  meetingsToRelink,
  relinksMeetings,
  splitFrontmatter,
  type AutomationRule,
  type MeetingsNotLinked,
  type VaultPath,
} from '@dfai/domain';
import { matchedPaths, type RuleQueryPorts } from './plan-run.ts';

/** How many matched meetings are read at once while looking for those not linked. */
const READ_BATCH = 200;

/**
 * The meetings a rule's run by hand links again before anything else
 * (#192): those its query matches whose linking failed. Null for a rule
 * that does not link meetings (`relinksMeetings`), or when every meeting it
 * matches is linked. Nothing is written. Rejects as `matchedPaths` does.
 */
export async function meetingsNotLinked({
  ports,
  rule,
  today,
}: {
  ports: RuleQueryPorts;
  rule: Pick<AutomationRule, 'which' | 'olderThanDays' | 'action'>;
  /** `YYYY-MM-DD`, from the injected clock. */
  today: string;
}): Promise<MeetingsNotLinked | null> {
  if (!relinksMeetings(rule)) return null;
  const matched = await matchedPaths({ ports, rule, today });
  const read: { path: VaultPath; properties: Readonly<Record<string, unknown>> }[] = [];
  let found: MeetingsNotLinked | null = null;
  for (let start = 0; start < matched.length; start += READ_BATCH) {
    const batch = matched.slice(start, start + READ_BATCH);
    const texts = new Map((await ports.fs.readNotes(batch)).map((file) => [file.path, file.text]));
    for (const path of batch) {
      const text = texts.get(path);
      // A note gone since the index answered is not there to link.
      if (text === undefined) continue;
      const { frontmatter } = splitFrontmatter(text);
      read.push({ path, properties: ports.markdown.frontmatterProperties(frontmatter) });
    }
    found = meetingsToRelink(read);
    // One past the cap is enough to say more wait.
    if (found?.capped === true) break;
  }
  return found;
}
