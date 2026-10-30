import type { MdRoot } from '@dfai/domain';
import type { Root } from 'mdast';
import { gfmToMarkdown } from 'mdast-util-gfm';
import { toMarkdown, type Unsafe } from 'mdast-util-to-markdown';
import {
  DEFAULT_MARKERS,
  GFM_WRITE_OPTIONS,
  stringifySettings,
  wholeCharacterReferences,
} from './stringify-settings.ts';

/*
 * A capture's tree written as markdown (#103, ADR-0049): by the serializer
 * the editor writes every block with, with its settings and GFM's, so the
 * stored bytes are what the editor would write, and every escape is the
 * library's. It is bundled, alone, into n8n's Code node too, so n8n writes a
 * capture with the same bytes.
 */

/**
 * What a capture escapes besides what the editor does: words a sender typed
 * that the editor would read as its own markup: `#` before a word would be
 * a tag (the editor writes a tag as `#word`, so it never escapes one). A
 * rule, a heading's underline or a table's delimiter row the library
 * already escapes.
 */
const CAPTURE_UNSAFE: Unsafe[] = [{ character: '#', after: '[^\\s#]', inConstruct: 'phrasing' }];

/** One block of a capture, written as the editor writes a block, without its trailing newline. */
export function writeCaptureMarkdown(root: MdRoot): string {
  const settings = stringifySettings(DEFAULT_MARKERS);
  const written = toMarkdown(root as unknown as Root, {
    ...settings,
    unsafe: [...(settings.unsafe ?? []), ...CAPTURE_UNSAFE],
    extensions: [gfmToMarkdown(GFM_WRITE_OPTIONS)],
  });
  return wholeCharacterReferences(written.replace(/\n+$/, ''));
}
