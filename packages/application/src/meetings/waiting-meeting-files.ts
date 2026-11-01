import {
  declaresImport,
  importOutcomeOf,
  postProcessingFactsOf,
  splitFrontmatter,
  type VaultPath,
  type WaitingMeetingFile,
} from '@dfai/domain';
import { postProcessingKeyOf } from '../automations/post-processing-ledger.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import type { VaultFsPort } from '../vault/ports.ts';
import { writtenAt } from '../vault/written-at.ts';
import { readFrontmatter } from './meeting-reading.ts';

/** What reading the files where meetings land needs. */
export interface WaitingMeetingPorts {
  readonly fs: VaultFsPort;
  readonly markdown: MarkdownPort;
}

/** How many files are read at once: the host answers each read on its own, and a vault's history is long. */
export const WAITING_READS_AT_ONCE = 8;

/** What each file listed holds, as the import reads it, read a few at a time. */
export async function readWaitingMeetings(
  ports: WaitingMeetingPorts,
  paths: readonly VaultPath[],
): Promise<WaitingMeetingFile[]> {
  const files: WaitingMeetingFile[] = new Array<WaitingMeetingFile>(paths.length);
  let next = 0;
  const worker = async () => {
    while (next < paths.length) {
      const at = next;
      next += 1;
      files[at] = await readWaitingMeeting(ports, paths[at]!);
    }
  };
  const workers = Math.min(WAITING_READS_AT_ONCE, paths.length);
  await Promise.all(Array.from({ length: workers }, worker));
  return files;
}

async function readWaitingMeeting(
  ports: WaitingMeetingPorts,
  path: VaultPath,
): Promise<WaitingMeetingFile> {
  let read: Awaited<ReturnType<VaultFsPort['readTextFile']>>;
  try {
    read = await ports.fs.readTextFile(path);
  } catch {
    // Unreadable, or gone since it was listed: not the import's to settle, so it never counts.
    return { path, read: null };
  }
  const { frontmatter, body } = splitFrontmatter(read.text);
  const reading = readFrontmatter(ports.markdown, frontmatter);
  // Frontmatter that does not read cannot be stamped either.
  if (reading.problem !== null) return { path, read: null };
  return {
    path,
    read: {
      importDeclared: declaresImport(reading.properties),
      importOutcome: importOutcomeOf(reading.properties),
      modifiedAt: writtenAt(read),
      postProcessing: postProcessingFactsOf({
        body,
        properties: reading.properties,
        key: postProcessingKeyOf({ text: read.text, properties: reading.properties }),
      }),
    },
  };
}
