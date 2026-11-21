import { appendToBody, joinFrontmatter, splitFrontmatter, type VaultPath } from '@dfai/domain';
import { setNoteProperties, type PropertyChanges } from '../query/set-property.ts';
import { linkedTypeProblems } from '../types/linked-types.ts';
import { loadObjectTypes, noteTypeName } from '../types/load-types.ts';
import { listVaultNotes } from '../vault/read-vault.ts';
import { ApiError } from './api-error.ts';
import { bodyObject, optionalModified, requiredString, isRecord, type Fields } from './fields.ts';
import {
  answerWithNote,
  checkIfModified,
  guardedWrite,
  notePathOf,
  readNote,
  toApiNote,
} from './note-io.ts';
import type { RouteResult, VaultRequest } from './vault-request.ts';

/**
 * Sets or removes properties.
 *
 * A note open in a pane is written through that pane, as a board drag is, so
 * the pane's editor never saves its older copy over the change. A null value
 * removes the key.
 */
export async function setPropertiesRoute(request: VaultRequest): Promise<RouteResult> {
  const path = await notePathOf(request);
  const fields = bodyObject(request.body);
  const set = propertiesToSet(fields);
  const ifModified = optionalModified(fields, 'ifModified');

  const { text, modified } = await readNote(request, path);
  checkIfModified(path, modified, ifModified);
  await refuseLinksOfTheWrongType(request, { text, set });

  await writeProperties(request, { path, expected: modified, values: set });
  return answerWithNote(request, { path });
}

/**
 * Writes properties to a note read at `expected`: through the pane holding
 * it when there is one, so its editor never saves an older copy over them.
 * A task is held to its rules as the app holds it (ADR-0029), by the write
 * itself — the pane's save or `setNoteProperties`: finishing it dates it,
 * and Waiting never needs anyone to wait on (#202).
 */
export async function writeProperties(
  request: VaultRequest,
  { path, expected, values }: { path: VaultPath; expected: number; values: PropertyChanges },
): Promise<void> {
  await guardedWrite(request, { path, expected }, async () => {
    if (await request.openNotes.setPropertiesIfOpen({ path, values })) return;
    await setNoteProperties({
      fs: request.fs,
      markdown: request.markdown,
      path,
      values,
      today: request.clock.today(),
      ifModified: expected,
    });
  });
}

/** Adds markdown after the body. `ifModified` is optional here. */
export async function appendRoute(request: VaultRequest): Promise<RouteResult> {
  const path = await notePathOf(request);
  const fields = bodyObject(request.body);
  const markdown = requiredString(fields, 'markdown');
  const ifModified = optionalModified(fields, 'ifModified');
  return writeBody(request, {
    path,
    ifModified,
    body: (current) => appendToBody(current, markdown),
  });
}

/** Replaces the body. Without `ifModified` it would be a blind overwrite, so it is required. */
export async function replaceBodyRoute(request: VaultRequest): Promise<RouteResult> {
  const path = await notePathOf(request);
  const fields = bodyObject(request.body);
  const markdown = requiredString(fields, 'markdown');
  const ifModified = optionalModified(fields, 'ifModified');
  if (ifModified === undefined) {
    throw new ApiError(
      'invalid',
      'ifModified is required: read the note first and pass its modified',
    );
  }
  return writeBody(request, { path, ifModified, body: () => markdown });
}

/**
 * Writes a new body under the note's frontmatter, byte for byte as it was.
 *
 * Refused when a pane holds unsaved edits to the note: writing under it would
 * be overwritten by its next save, or overwrite what was typed. A pane holding
 * it with nothing unsaved is reloaded once the write lands.
 */
async function writeBody(
  request: VaultRequest,
  {
    path,
    ifModified,
    body,
  }: { path: VaultPath; ifModified: number | undefined; body: (current: string) => string },
): Promise<RouteResult> {
  const { text, modified } = await readNote(request, path);
  checkIfModified(path, modified, ifModified);
  const pane = request.openNotes.state(path);
  if (pane === 'dirty') {
    throw new ApiError('unsaved_in_app', `${path} is open in DFAI with unsaved edits`);
  }

  const document = splitFrontmatter(text);
  const contents = joinFrontmatter(document.frontmatter, body(document.body));
  const written = await guardedWrite(request, { path, expected: modified }, () =>
    request.fs.writeTextFile({ path, contents, expectedModified: modified }),
  );
  if (pane === 'clean') request.openNotes.reload(path);

  const note = toApiNote({
    markdown: request.markdown,
    path,
    contents: { text: contents, modified: written },
  });
  return { status: 200, body: { note } };
}

/**
 * Refuses, with `invalid`, a relation set to link a note of a type it does
 * not point at — a Project linking a person (P30-01). The note's type is the
 * one it will have: `set.type` when the request changes it.
 */
async function refuseLinksOfTheWrongType(
  request: VaultRequest,
  { text, set }: { text: string; set: Fields },
): Promise<void> {
  const own = request.markdown.frontmatterProperties(splitFrontmatter(text).frontmatter);
  const typeName = noteTypeName(Object.hasOwn(set, 'type') ? set : own);
  if (typeName === null) return;
  const type = (await loadObjectTypes(request)).find((each) => each.name === typeName);
  if (type === undefined) return;
  const problems = await linkedTypeProblems({
    fs: request.fs,
    markdown: request.markdown,
    properties: type.properties,
    values: set,
    notePaths: await listVaultNotes({ fs: request.fs }),
  });
  const [problem] = Object.values(problems);
  if (problem !== undefined) throw new ApiError('invalid', problem);
}

function propertiesToSet(fields: Fields): Fields {
  const set = fields['set'];
  if (!isRecord(set)) throw new ApiError('invalid', 'set must be an object of properties');
  const keys = Object.keys(set);
  if (keys.length === 0) throw new ApiError('invalid', 'set must name at least one property');
  if (keys.some((key) => key.trim() === '')) {
    throw new ApiError('invalid', 'set must not have an empty property name');
  }
  return set;
}
