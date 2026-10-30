import {
  compileAnyMarkQuery,
  compileMarkedAmongQuery,
  MARKED_AMONG_CHUNK,
  markedMeetingsOf,
  meetingsToRelink,
  RELINKS_PER_RUN,
  relinksMeetings,
  splitFrontmatter,
  type AutomationRule,
  type MeetingsNotLinked,
  type VaultPath,
} from '@dfai/domain';
import { matchedPaths, type RuleQueryPorts } from './plan-run.ts';

/**
 * The meetings a rule's run by hand links again before anything else
 * (#192): those its query matches whose linking is still owed, newest first.
 * Null for a rule that does not link meetings (`relinksMeetings`), or when
 * none is. Nothing is written.
 *
 * The index is asked first whether any note carries the mark, so a vault
 * with none costs one small query: no file read, and not the rule's query.
 * Otherwise the marks are asked for among the notes the rule's query
 * matches — so marks on meetings it cannot reach never hide one it can —
 * and only those are read, newest first until one past the cap, since the
 * index may be behind the files. Rejects as `matchedPaths` does, or when
 * the index does.
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
  const any = compileAnyMarkQuery();
  if ((await ports.index.query(any.sql, any.parameters)).rows.length === 0) return null;
  const marked = await markedAmong(ports, await matchedPaths({ ports, rule, today }));
  let found: MeetingsNotLinked | null = null;
  const read: { path: VaultPath; properties: Readonly<Record<string, unknown>> }[] = [];
  for (let start = 0; start < marked.length && found?.capped !== true; start += READ_BATCH) {
    read.push(...(await frontmatterOf(ports, marked.slice(start, start + READ_BATCH))));
    found = meetingsToRelink(read);
  }
  return found;
}

/** How many marked meetings are read at once: enough for a run's cap and one more. */
const READ_BATCH = RELINKS_PER_RUN + 1;

/** Which of the matched notes the index says carry the mark, newest first. */
async function markedAmong(
  ports: RuleQueryPorts,
  matched: readonly VaultPath[],
): Promise<VaultPath[]> {
  const rows: (readonly unknown[])[] = [];
  for (let start = 0; start < matched.length; start += MARKED_AMONG_CHUNK) {
    const { sql, parameters } = compileMarkedAmongQuery(
      matched.slice(start, start + MARKED_AMONG_CHUNK),
    );
    rows.push(...(await ports.index.query(sql, parameters)).rows);
  }
  return markedMeetingsOf(rows);
}

/** Each note's frontmatter as it is now, in the order given; a note gone since the index answered is left out. */
async function frontmatterOf(
  ports: RuleQueryPorts,
  paths: readonly VaultPath[],
): Promise<{ path: VaultPath; properties: Readonly<Record<string, unknown>> }[]> {
  const texts = new Map((await ports.fs.readNotes(paths)).map((file) => [file.path, file.text]));
  return paths.flatMap((path) => {
    const text = texts.get(path);
    if (text === undefined) return [];
    const { frontmatter } = splitFrontmatter(text);
    return [{ path, properties: ports.markdown.frontmatterProperties(frontmatter) }];
  });
}
