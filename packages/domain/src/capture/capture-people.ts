import { wikiLinkTargetFor } from '../markdown/resolve-wikilink.ts';
import { matchAttendees, type DirectoryPerson } from '../meeting-links/attendee-matching.ts';
import type { VaultPath } from '../vault/vault-path.ts';
import type { Capture, CaptureAuthor } from './mapping/capture-payload.ts';

/**
 * Who each author of a capture is among the vault's people, found by email
 * alone — a Slack display name is too loose to link by — the way meeting
 * import compares addresses (`matchAttendees`), so the two never disagree on
 * whose an address is. An author with no address, one no person has, or one
 * two people share, is written by name. Answers the wiki link target of
 * their Person note, as `CaptureOptions.personFor` asks it.
 */
export function capturePeople({
  capture,
  people,
  notePaths,
}: {
  capture: Capture;
  people: readonly DirectoryPerson[];
  notePaths: readonly VaultPath[];
}): (author: CaptureAuthor) => string | null {
  const authors = [capture.message, ...capture.thread].map((message) => message.author);
  const attendees = authors.flatMap(({ name, email }) =>
    email === null ? [] : [{ name, email, group: false }],
  );
  const { linked } = matchAttendees(attendees, people, []);
  const byEmail = new Map(
    linked
      .filter(({ by }) => by === 'email')
      .map(({ attendee, person }) => [attendee.email, wikiLinkTargetFor(person.path, notePaths)]),
  );
  return (author) => (author.email === null ? null : (byEmail.get(author.email) ?? null));
}
