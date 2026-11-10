/*
 * Text from outside DFAI, made safe to hold before it is read as anything:
 * no control characters, no direction overrides, no half surrogate pairs.
 * The mapper runs in the app and in n8n's Code node, so nothing here asks
 * the engine for more than a regular expression.
 */

import { BYTE_ORDER_MARK, DIRECTION_MARKS, LONE_SURROGATE } from '../../text/hidden-characters.ts';

/**
 * Control characters but the line feed (YAML and the editor refuse some, and
 * none means anything in a note), the {@link DIRECTION_MARKS} and the
 * {@link BYTE_ORDER_MARK}.
 */
const UNSAFE = new RegExp(
  `[\\u0000-\\u0009\\u000B-\\u001F\\u007F-\\u009F${DIRECTION_MARKS}${BYTE_ORDER_MARK}]`,
  'gu',
);

/** Text with every line ending a line feed, a tab a space, and nothing {@link UNSAFE} left in it. */
export function cleanText(text: string): string {
  return text
    .replace(/\r\n?|[\u2028\u2029]/g, '\n')
    .replace(/\t/g, ' ')
    .replace(LONE_SURROGATE, '\uFFFD')
    .replace(UNSAFE, '');
}

/** Text as one line: cleaned, its runs of white space one space, trimmed. */
export function oneLineText(text: string): string {
  return cleanText(text).replace(/\s+/g, ' ').trim();
}

/** The three entities Slack writes for `&`, `<` and `>` in a message's text, read back. */
export function decodeSlackEntities(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
