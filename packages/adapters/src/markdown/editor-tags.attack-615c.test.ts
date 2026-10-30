import { describe, expect, it } from 'vitest';
import { noteTags } from '@dfai/domain';
import { parseMarkdownBody, renderBlock } from './markdown-blocks.ts';
import { remarkMarkdown } from './markdown-port.ts';

/*
 * Third attack on PR #615 (#103): a capture escapes `#` before a word
 * (`capture-markdown.ts`), and the editor's settings moved to
 * `stringify-settings.ts` beside it. A tag the user typed is still a tag
 * once its paragraph is edited and saved: the escape stays the capture's.
 */

const tagsOf = (markdown: string) =>
  noteTags({
    tagsProperty: undefined,
    body: markdown,
    ranges: remarkMarkdown.textRanges(markdown),
  });

describe('a tag typed in the editor survives a save', () => {
  it.each([
    ['a tag', 'Ping #ops today', ['ops']],
    ['a nested tag', 'See #ops/oncall now', ['ops/oncall']],
    ['a tag in bold', 'Hot **#ops** item', ['ops']],
    ['a tag in a list item', '- [ ] chase #ops', ['ops']],
  ])('%s', (_, markdown, tags) => {
    const [node] = parseMarkdownBody(`${markdown}\n`).doc.content;
    const saved = renderBlock(node!);
    expect(saved).not.toContain('\\#');
    expect(tagsOf(saved)).toEqual(tagsOf(markdown));
    expect(tagsOf(saved).map((tag) => tag.key)).toEqual(tags);
  });
});
