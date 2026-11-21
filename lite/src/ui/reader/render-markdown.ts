import DOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';
import type { StateCore, Token } from 'markdown-it';
import { findTags, tagKey, wikiLinkLabel, wikiLinkSpans } from '../../application/index.ts';

/** What a render needs from the vault: whether a link opens a note today. */
// A type, not an interface: markdown-it's `env` is an index signature, which only a type alias meets.
export type RenderEnv = {
  readonly resolves: (target: string) => boolean;
};

const TASK = /^\[([ xX])\]\s+/;

/** `- [ ] item` and `- [x] item`: a list item's first words become a (read-only) checkbox. */
function taskLists(state: StateCore): void {
  const tokens = state.tokens;
  tokens.forEach((token, at) => {
    if (token.type !== 'inline' || tokens[at - 2]?.type !== 'list_item_open') return;
    const first = token.children?.[0];
    const match = first?.type === 'text' ? TASK.exec(first.content) : null;
    if (first === undefined || match === null) return;
    first.content = first.content.slice(match[0].length);
    const box = new state.Token('html_inline', '', 0);
    const checked = match[1] !== ' ' ? ' checked' : '';
    box.content = `<input type="checkbox" class="task-box" disabled${checked}> `;
    token.children?.unshift(box);
    tokens[at - 2]?.attrJoin('class', 'task-item');
  });
}

/** Splits one text token into text, wiki-link and tag tokens. */
function splitText(state: StateCore, text: Token): Token[] {
  const content = text.content;
  const links = wikiLinkSpans(content).map((span) => ({ ...span, kind: 'link' as const }));
  const tags = findTags(content)
    .filter((tag) => !links.some((link) => tag.start >= link.start && tag.start < link.end))
    .map((tag) => ({ ...tag, kind: 'tag' as const }));
  const pieces = [...links, ...tags].sort((left, right) => left.start - right.start);
  if (pieces.length === 0) return [text];
  const out: Token[] = [];
  let cursor = 0;
  const pushText = (value: string) => {
    if (value === '') return;
    const token = new state.Token('text', '', 0);
    token.content = value;
    out.push(token);
  };
  for (const piece of pieces) {
    pushText(content.slice(cursor, piece.start));
    const token = new state.Token(piece.kind === 'link' ? 'wiki_link' : 'tag_pill', '', 0);
    token.meta =
      piece.kind === 'link'
        ? { target: piece.link.target, label: wikiLinkLabel(piece.link) }
        : { name: piece.name };
    out.push(token);
    cursor = piece.end;
  }
  pushText(content.slice(cursor));
  return out;
}

function linksAndTags(state: StateCore): void {
  for (const token of state.tokens) {
    if (token.type !== 'inline' || token.children === null) continue;
    token.children = token.children.flatMap((child) =>
      child.type === 'text' ? splitText(state, child) : [child],
    );
  }
}

function createRenderer() {
  const md = new MarkdownIt({ html: true, linkify: true });
  const escape = md.utils.escapeHtml;
  md.core.ruler.after('text_join', 'task_lists', taskLists);
  md.core.ruler.after('task_lists', 'links_and_tags', linksAndTags);
  md.renderer.rules['wiki_link'] = (tokens, at, _options, env) => {
    const { target, label } = tokens[at]?.meta as { target: string; label: string };
    // `env` is what `renderMarkdown` passes, typed loosely by markdown-it.
    const resolves = (env as Partial<RenderEnv> | undefined)?.resolves;
    const kind = resolves?.(target) !== false ? 'link-pill' : 'link-pill is-unresolved';
    return `<a href="#" class="${kind}" data-wikilink="${escape(target)}">${escape(label)}</a>`;
  };
  md.renderer.rules['tag_pill'] = (tokens, at) => {
    const { name } = tokens[at]?.meta as { name: string };
    const href = `#/tags/${encodeURIComponent(tagKey(name))}`;
    return `<a href="${escape(href)}" class="tag-pill" data-tag="${escape(name)}">#${escape(name)}</a>`;
  };
  return md;
}

const EXTERNAL = /^(https?:|mailto:)/i;

// A link out of the vault opens in a new tab and tells the other site nothing.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName !== 'A') return;
  const href = node.getAttribute('href') ?? '';
  if (EXTERNAL.test(href)) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  } else {
    node.removeAttribute('target');
  }
});

const renderer = createRenderer();

/** A note's markdown as HTML that is safe to put in the page: sanitised, always. */
export function renderMarkdown(markdown: string, env: RenderEnv): string {
  return DOMPurify.sanitize(renderer.render(markdown, env));
}
