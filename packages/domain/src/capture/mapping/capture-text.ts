/*
 * Text from outside DFAI, made safe to hold before it is read as anything:
 * no control characters, no direction overrides, no half surrogate pairs.
 * The mapper runs in the app and in n8n's Code node, so nothing here asks
 * the engine for more than a regular expression.
 */

/**
 * Control characters but the line feed (YAML and the editor refuse some, and
 * none means anything in a note), the marks that turn text right to left or
 * back (they disguise a link or a file name as another), and the byte-order mark.
 */
const UNSAFE =
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
  /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu;

/** Half of a surrogate pair with no other half: JSON can carry one, UTF-8 cannot write it. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

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
