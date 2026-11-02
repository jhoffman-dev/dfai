import type { WrittenAt } from './ports.ts';

/**
 * When a file was last written, in epoch milliseconds, or null when its vault
 * cannot tell (ADR-0053). Every reader of a file's time asks this, never
 * `modified`, which on the GitHub vault is a version. An unknown time is never
 * "changed since" anything: a reader that would act on one acts as if nothing
 * changed.
 */
export function writtenAt(file: WrittenAt & { readonly modified: number }): number | null {
  return file.modifiedAt === undefined ? file.modified : file.modifiedAt;
}
