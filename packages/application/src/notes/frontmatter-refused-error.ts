/**
 * A frontmatter change refused before anything is written, because the block
 * cannot take it without guessing — a property it lists twice, say, where the
 * writer cannot tell which of the two the person meant.
 *
 * `message` is for the person, in words they can act on; `key` is the
 * property the change named.
 */
export class FrontmatterRefusedError extends Error {
  readonly key: string;

  constructor({ key, message, cause }: { key: string; message: string; cause?: unknown }) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'FrontmatterRefusedError';
    this.key = key;
  }
}
