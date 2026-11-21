/** How often one tag is used across the vault, as the index counts it. */
export interface TagCount {
  readonly key: string;
  /** How it was first written, which is how it is shown. */
  readonly name: string;
  /** Uses of this exact tag, not of the tags nested under it. */
  readonly count: number;
}

/** One tag in the tree: its uses, and the tags nested under it. */
export interface TagTreeNode {
  readonly key: string;
  /** The whole name, `para/resource`. */
  readonly name: string;
  /** The last part of it, `resource`, which is what the tree shows. */
  readonly label: string;
  /** Uses of this exact tag. A parent only ever written with a child has none. */
  readonly count: number;
  /** Uses of it and of everything nested under it: what its row shows. */
  readonly total: number;
  readonly children: readonly TagTreeNode[];
}

export type TagSort = 'name' | 'frequency';

interface Building {
  key: string;
  name: string;
  label: string;
  count: number;
  children: Map<string, Building>;
}

/**
 * The vault's tags as a tree: `#para/resource` sits under `para`, which is
 * there whether or not `#para` is ever written on its own. A tag no note uses
 * any more has no count, so it is simply not here — nothing has to remove it.
 */
export function buildTagTree(counts: readonly TagCount[], sort: TagSort): TagTreeNode[] {
  const roots = new Map<string, Building>();
  for (const { key, name, count } of counts) {
    if (count <= 0) continue;
    place({ roots, keys: key.split('/'), names: name.split('/'), count });
  }
  return finish(roots, sort);
}

function place({
  roots,
  keys,
  names,
  count,
}: {
  roots: Map<string, Building>;
  keys: readonly string[];
  names: readonly string[];
  count: number;
}): void {
  let level = roots;
  let node: Building | undefined;
  keys.forEach((_, depth) => {
    const key = keys.slice(0, depth + 1).join('/');
    node = level.get(key);
    if (node === undefined) {
      const name = names.slice(0, depth + 1).join('/');
      node = { key, name, label: names[depth] ?? '', count: 0, children: new Map() };
      level.set(key, node);
    }
    level = node.children;
  });
  if (node !== undefined) node.count += count;
}

function finish(level: Map<string, Building>, sort: TagSort): TagTreeNode[] {
  const nodes = [...level.values()].map((node) => {
    const children = finish(node.children, sort);
    const total = node.count + children.reduce((sum, child) => sum + child.total, 0);
    return {
      key: node.key,
      name: node.name,
      label: node.label,
      count: node.count,
      total,
      children,
    };
  });
  return nodes.sort(sort === 'name' ? byLabel : byTotalThenLabel);
}

function byLabel(left: TagTreeNode, right: TagTreeNode): number {
  return (
    left.label.localeCompare(right.label, 'en', { sensitivity: 'base' }) ||
    left.key.localeCompare(right.key)
  );
}

function byTotalThenLabel(left: TagTreeNode, right: TagTreeNode): number {
  return right.total - left.total || byLabel(left, right);
}

/** The node for `key`, wherever it sits in the tree, or null. */
export function findTagNode(tree: readonly TagTreeNode[], key: string): TagTreeNode | null {
  for (const node of tree) {
    if (node.key === key) return node;
    const found = findTagNode(node.children, key);
    if (found !== null) return found;
  }
  return null;
}
