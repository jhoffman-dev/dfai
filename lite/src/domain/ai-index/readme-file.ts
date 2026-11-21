import type { TagTreeNode } from '../tags/index.ts';
import type { FolderSummary } from './folder-files.ts';
import type { MeetingMonth } from './meeting-files.ts';
import { TAG_FILE } from './tag-file.ts';
import { INDEX_ROOT, fileText, type IndexFile } from './text.ts';

/** Past this many tags the README points to tags.md instead of listing them. */
const MAX_TAGS_INLINE = 40;

export interface ReadmeInput {
  readonly total: number;
  readonly folders: readonly FolderSummary[];
  readonly months: readonly MeetingMonth[];
  readonly tags: readonly TagTreeNode[];
  readonly conflictCopies: readonly string[];
}

/** `_index/README.md`: the map — what the index is, then where to read next. */
export function readmeFile(input: ReadmeInput): IndexFile {
  const lines = [
    '# Vault index',
    'Generated from the notes on every push; never edit it. If a note and the index disagree, the note is right.',
    'Read a folder file for its notes (one line each: path, tags, links, backlinks, first sentence), tags.md for tags, meetings/ by month.',
    'Open only the notes that matter; search the repository for an exact phrase.',
    '',
    `${input.total} notes.`,
    '',
    '## Folders',
    'Line: folder | notes | index file.',
    ...input.folders.map(
      ({ folder, count, file }) =>
        `${folder === '' ? '(vault root)' : `${folder}/`} | ${count} | ${file}`,
    ),
    ...meetingLines(input.months),
    ...tagLines(input.tags),
    ...conflictLines(input.conflictCopies),
  ];
  return { path: `${INDEX_ROOT}/README.md`, text: fileText(lines) };
}

function meetingLines(months: readonly MeetingMonth[]): string[] {
  if (months.length === 0) return [];
  return [
    '',
    '## Meetings',
    'Line: month | meetings | index file.',
    ...months.map(({ month, count, file }) => `${month} | ${count} | ${file}`),
  ];
}

function tagLines(tags: readonly TagTreeNode[]): string[] {
  const all: TagTreeNode[] = [];
  const visit = (node: TagTreeNode): void => {
    all.push(node);
    node.children.forEach(visit);
  };
  tags.forEach(visit);
  if (all.length === 0) return ['', '## Tags', 'None yet.'];
  if (all.length > MAX_TAGS_INLINE) {
    return ['', '## Tags', `${all.length} tags: see ${TAG_FILE}.`];
  }
  return [
    '',
    '## Tags',
    `#tag (notes). Which notes: ${TAG_FILE}.`,
    all.map(({ name, total }) => `#${name} (${total})`).join(' '),
  ];
}

function conflictLines(paths: readonly string[]): string[] {
  if (paths.length === 0) return [];
  return [
    '',
    '## Conflict copies',
    'Second versions the app kept when a note changed on two sides. Leave them for the owner unless asked to merge.',
    ...paths,
  ];
}
