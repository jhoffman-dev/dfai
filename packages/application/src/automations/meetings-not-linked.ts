import {
  compileMarkedMeetingsQuery,
  markedMeetingsOf,
  meetingsToRelink,
  relinksMeetings,
  splitFrontmatter,
  type AutomationRule,
  type MeetingsNotLinked,
} from '@dfai/domain';
import { matchedPaths, type RuleQueryPorts } from './plan-run.ts';

/**
 * The meetings a rule's run by hand links again before anything else
 * (#192): those its query matches whose linking is still owed. Null for a
 * rule that does not link meetings (`relinksMeetings`), or when none is.
 * Nothing is written. The index is asked first for the notes that carry the
 * mark, so a vault with none costs one small query and reads no file; only
 * those are matched against the rule's query and read, since the index may
 * be behind them. Rejects as `matchedPaths` does, or when the index does.
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
  const { sql, parameters } = compileMarkedMeetingsQuery();
  const marked = markedMeetingsOf((await ports.index.query(sql, parameters)).rows);
  if (marked.length === 0) return null;
  const matched = await matchedPaths({ ports, rule, today, among: marked });
  if (matched.length === 0) return null;
  const texts = new Map((await ports.fs.readNotes(matched)).map((file) => [file.path, file.text]));
  // A note gone since the index answered is not there to link.
  const read = matched.flatMap((path) => {
    const text = texts.get(path);
    if (text === undefined) return [];
    const { frontmatter } = splitFrontmatter(text);
    return [{ path, properties: ports.markdown.frontmatterProperties(frontmatter) }];
  });
  return meetingsToRelink(read);
}
