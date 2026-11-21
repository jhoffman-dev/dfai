import type { VaultIndex } from '../index/index.ts';
import { buildTagTree, type TagTreeNode } from '../tags/index.ts';
import { INDEX_ROOT, byCode, fileText, type IndexFile } from './text.ts';

/** A tag with more notes than this lists the first ones and says how to find the rest. */
const MAX_PATHS_PER_TAG = 25;

export const TAG_FILE = `${INDEX_ROOT}/tags.md`;

/** Every tag in use, nested tags under their parent, in code-unit order of each part. */
export function sortedTagTree(index: VaultIndex): TagTreeNode[] {
  return sortTree(buildTagTree(index.tagCounts(), 'name'));
}

function sortTree(nodes: readonly TagTreeNode[]): TagTreeNode[] {
  return [...nodes]
    .sort((left, right) => byCode(left.key, right.key))
    .map((node) => ({ ...node, children: sortTree(node.children) }));
}

/** `_index/tags.md`: each tag, its note count, and the notes using exactly it. */
export function tagFile(index: VaultIndex, tree: readonly TagTreeNode[]): IndexFile {
  const lines = [
    '# Tags',
    'Line: #tag (notes with it or a tag under it): paths of notes with exactly it, " | " apart. Nested tags are indented under their parent.',
  ];
  const visit = (node: TagTreeNode, depth: number): void => {
    lines.push(tagLine(index, node, depth));
    for (const child of node.children) visit(child, depth + 1);
  };
  for (const root of tree) visit(root, 0);
  if (tree.length === 0) lines.push('No tags yet.');
  return { path: TAG_FILE, text: fileText(lines) };
}

function tagLine(index: VaultIndex, node: TagTreeNode, depth: number): string {
  const head = `${'  '.repeat(depth)}#${node.name} (${node.total})`;
  const paths = index.notesWithTag(node.key, { nested: false });
  if (paths.length === 0) return head;
  const shown = paths.slice(0, MAX_PATHS_PER_TAG).join(' | ');
  const more =
    paths.length > MAX_PATHS_PER_TAG
      ? ` | +${paths.length - MAX_PATHS_PER_TAG} more: search the repository for #${node.name}`
      : '';
  return `${head}: ${shown}${more}`;
}
