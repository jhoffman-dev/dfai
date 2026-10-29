import type { Emphasis, Nodes, Parents, Strong } from 'mdast';
import { defaultHandlers, type Info, type State } from 'mdast-util-to-markdown';

/**
 * Italic and bold that sit side by side, written so they read back apart
 * (A21-03). Remark writes both with `*`, and `*a*` then `**b**` is
 * `*a***b**`: markdown reads a run of three stars as one delimiter, and the
 * text comes back with stars in it and a mark gone. The second of two
 * neighbours is written with `_` instead — `*a*__b__` — and a third with `*`
 * again; a run whose last `_` the words after it would carry on into a mail
 * address starts with `_` instead (`markersOf`). Remark's own handlers do the writing, with the marker set for the
 * one node, so its care over which characters to encode still applies.
 */
export const writeEmphasis = alternating('emphasis');
export const writeStrong = alternating('strong');

type Attention = Emphasis | Strong;

const isAttention = (node: Nodes | undefined): node is Attention =>
  node?.type === 'emphasis' || node?.type === 'strong';

/** The marker each node of a parent's runs of neighbours is written with, worked out once per parent. */
type Markers = WeakMap<Parents, Map<Nodes, '*' | '_'>>;

/** Per serialization: a tree may be changed between two of them, so nothing is kept across. */
const markersByState = new WeakMap<State, Markers>();

/**
 * Whether the words after a run can carry on a mail address through the
 * run's last `_` (third attack on PR #615): `__Quill__@example.com` is a
 * mail link to GFM, its name `__Quill__`, and the bold is gone. An `@` and
 * a dotted domain straight after the closing `_` — or after more of a name's
 * characters — does it; nothing else changes how a note is written.
 */
function joinsAnAddress(next: Nodes | undefined): boolean {
  return next?.type === 'text' && /^[\w.+-]*@[-\w]+(?:\.[-\w]+)+/.test(next.value);
}

/**
 * The markers for every run of italic and bold neighbours among `children`,
 * in one pass: `*`, `_`, `*`… from the run's start — or `_`, `*`, `_`… when
 * the run would end in a `_` that the words after it could carry on into a
 * mail address, so its last is a `*`. Linear in the children, where asking
 * each node about all the neighbours before it was cubic on a long run, and
 * recursed as deep as the run.
 */
function markersOf(children: readonly Nodes[]): Map<Nodes, '*' | '_'> {
  const markers = new Map<Nodes, '*' | '_'>();
  let start = 0;
  while (start < children.length) {
    if (!isAttention(children[start])) {
      start += 1;
      continue;
    }
    let end = start;
    while (end < children.length && isAttention(children[end])) end += 1;
    const endsInUnderscore = (end - start) % 2 === 0;
    const shifted = endsInUnderscore && joinsAnAddress(children[end]);
    for (let at = start; at < end; at += 1) {
      const second = (at - start) % 2 === 1;
      markers.set(children[at] as Nodes, second !== shifted ? '_' : '*');
    }
    start = end;
  }
  return markers;
}

/** The marker `node` is written with: `*`, or `_` beside a neighbour written with `*`. */
function markerOf(node: Attention, parent: Parents | undefined, state: State): '*' | '_' {
  if (parent === undefined) return '*';
  let byParent = markersByState.get(state);
  if (byParent === undefined) {
    byParent = new WeakMap();
    markersByState.set(state, byParent);
  }
  let markers = byParent.get(parent);
  if (markers === undefined) {
    markers = markersOf(parent.children as Nodes[]);
    byParent.set(parent, markers);
  }
  return markers.get(node) ?? '*';
}

function alternating(option: 'emphasis' | 'strong') {
  const base = defaultHandlers[option] as (
    node: Attention,
    parent: Parents | undefined,
    state: State,
    info: Info,
  ) => string;
  const handler = (node: Attention, parent: Parents | undefined, state: State, info: Info) => {
    const before = state.options[option];
    state.options[option] = markerOf(node, parent, state);
    try {
      return base(node, parent, state, info);
    } finally {
      state.options[option] = before;
    }
  };
  handler.peek = (node: Attention, parent: Parents | undefined, state: State) =>
    markerOf(node, parent, state);
  return handler;
}
