import {
  createVaultPath,
  linkTakeover,
  nextAvailableNotePath,
  noteTitle,
  PEOPLE_FOLDER,
  PERSON_TYPE,
  newPersonRefusal,
  PERSON_EMAIL_KEY,
  splitFrontmatter,
  VAULT_ROOT,
  wikiLinkTargetFor,
  type KnownPerson,
  type ObjectType,
  type VaultPath,
} from '@dfai/domain';
import type { IndexPort } from '../index/ports.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import { quickAddContents } from '../quick-add/quick-add-note.ts';
import { findTypeTemplate, readTemplate, type NoteTemplate } from '../types/templates.ts';
import type { VaultFsPort } from '../vault/ports.ts';

/**
 * Every person in the vault — the notes declaring `type: person` — with when
 * each last changed, which `@` ranks them by. Archived ones are included, as
 * a link to one still opens it; the domain leaves them out of what is offered.
 */
export async function loadPeople({
  index,
}: {
  index: Pick<IndexPort, 'notesOfType' | 'manifest'>;
}): Promise<KnownPerson[]> {
  const [people, manifest] = await Promise.all([index.notesOfType(PERSON_TYPE), index.manifest()]);
  const modified = new Map(manifest.map((entry) => [entry.path, entry.modified]));
  return people.map(({ path }) => ({
    path: createVaultPath(path),
    modified: modified.get(path) ?? 0,
  }));
}

/** A person just made from `@`: their note, and what a link to it is written as. */
export interface CreatedPerson {
  readonly path: VaultPath;
  readonly target: string;
}

/** A person not made, for a reason the person asking is told in these words. */
export class PersonRefusedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'PersonRefusedError';
  }
}

/**
 * Makes a person from what was typed after `@`, as quick add makes one:
 * from the vault's Person template when it has one, filed in `People/`, a
 * name taken there numbered.
 *
 * Making a person never changes what a `[[link]]` already in the vault opens
 * (A21-02): when a note of that name exists, the new person is linked by
 * path, and if their note would still win links written to the other one, or
 * no link could hold the name, nothing is made and the reason is thrown.
 *
 * Answers with the link to write, worked out from the note as made — the name
 * may have been cleaned or numbered, and a link written from what was typed
 * would open some other note, or none. Given an `email`, the person's note
 * says it from the start, in the same one write (#909).
 */
export async function createPerson({
  fs,
  markdown,
  name,
  types,
  templates,
  notePaths,
  email,
}: {
  fs: VaultFsPort;
  markdown: Pick<MarkdownPort, 'frontmatterProperties' | 'updateFrontmatter'>;
  name: string;
  types: readonly ObjectType[];
  templates: readonly NoteTemplate[];
  notePaths: readonly VaultPath[];
  /** Their address, written as their `email`; left out for none. */
  email?: string;
}): Promise<CreatedPerson> {
  const refusal = newPersonRefusal(name);
  if (refusal !== null) throw new PersonRefusedError(refusal);

  // The type is built in (U-20), but a vault may not define it yet: a person
  // is then a note declaring the type, with no fields of its own.
  const type = types.find((known) => known.name === PERSON_TYPE) ?? {
    name: PERSON_TYPE,
    label: 'Person',
    properties: [],
  };
  const template = findTypeTemplate(templates, type);
  const made = quickAddContents({
    markdown,
    type,
    values: {},
    template: template === null ? null : await readTemplate({ fs, template }),
  });
  const contents = email === undefined ? made : withEmail(markdown, made, email);

  const folder = await peopleFolder(fs);
  const path = nextAvailableNotePath({ folder, name, taken: new Set<string>(notePaths) });
  const overtaken = linkTakeover(path, notePaths);
  if (overtaken !== null) {
    const title = noteTitle(path);
    throw new PersonRefusedError(
      `“${title}” was not added: [[${title}]] already opens ${overtaken}, and would open the new person instead. Rename one of them first.`,
    );
  }
  // Written at the path checked, not numbered past a clash on the way: a
  // number chosen after the check would be a name the check never saw.
  await fs.createNote({ path, contents });
  return { path, target: wikiLinkTargetFor(path, [...notePaths, path]) };
}

/** A new person's note, saying their address under `email` whatever the vault's Person type declares. */
function withEmail(
  markdown: Pick<MarkdownPort, 'updateFrontmatter'>,
  contents: string,
  email: string,
): string {
  const { frontmatter, body } = splitFrontmatter(contents);
  return markdown.updateFrontmatter(frontmatter, { [PERSON_EMAIL_KEY]: email }) + body;
}

/** The vault's people folder, as it is spelled there — made if there is none. */
async function peopleFolder(fs: VaultFsPort): Promise<VaultPath> {
  const top = await fs.listDirectory(VAULT_ROOT);
  const found = top.find((entry) => entry.path.toLowerCase() === PEOPLE_FOLDER.toLowerCase());
  if (found === undefined) {
    await fs.createFolder({ path: PEOPLE_FOLDER });
    return PEOPLE_FOLDER;
  }
  if (found.kind !== 'directory') {
    throw new PersonRefusedError(`${found.path} is a file, so people have nowhere to go`);
  }
  return found.path;
}
