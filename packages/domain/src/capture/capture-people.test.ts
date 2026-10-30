import { describe, expect, it } from 'vitest';
import { slackCapture, slackSource } from '../testing/slack-capture.ts';
import { resolveWikiLinkTarget } from '../markdown/resolve-wikilink.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import { compileCaptureHoldersQuery, holdsCapture } from './capture-holders.ts';
import { capturePeople } from './capture-people.ts';
import { readCapture } from './mapping/capture-payload.ts';

const person = (path: string, emails: string[], aliases: string[] = []) => ({
  path: createVaultPath(path),
  name: path.replace(/^.*\//, '').replace(/\.md$/, ''),
  emails,
  aliases,
  company: null,
});

const MARA = person('People/Mara Quill.md', ['Mara.Quill@Example.com']);
const TOBIAS = person('People/Tobias Fenn.md', ['tobias.fenn@example.com']);
const NOTES = [MARA.path, TOBIAS.path, createVaultPath('Projects/Mara Quill.md')];

describe('capturePeople: who wrote a capture, among the vault’s people (#103)', () => {
  const capture = readCapture(slackCapture());

  it('finds each author by their address, case aside, as meeting import compares one', () => {
    const personFor = capturePeople({ capture, people: [MARA, TOBIAS], notePaths: NOTES });
    const opened = (target: string | null) => resolveWikiLinkTarget(target ?? '', NOTES);
    expect(opened(personFor(capture.message.author))).toBe(MARA.path);
    expect(opened(personFor(capture.thread[0]!.author))).toBe(TOBIAS.path);
  });

  it('never links by name alone: a Slack display name is too loose', () => {
    for (const author of [
      { name: 'Mara Quill' },
      { name: 'Mara Quill', email: 'mara@elsewhere.example' },
    ]) {
      const named = readCapture(slackCapture({ source: slackSource({ author }), thread: [] }));
      // One with no address on file, whom meeting import would link by this name.
      const unaddressed = person('People/Mara Quill.md', []);
      const personFor = capturePeople({ capture: named, people: [unaddressed], notePaths: NOTES });
      expect(personFor(named.message.author)).toBeNull();
    }
  });

  it('links nobody when the address is no one’s, or two people’s', () => {
    const twin = person('People/Mara Q.md', ['mara.quill@example.com']);
    expect(
      capturePeople({ capture, people: [TOBIAS], notePaths: NOTES })(capture.message.author),
    ).toBeNull();
    expect(
      capturePeople({ capture, people: [MARA, twin], notePaths: NOTES })(capture.message.author),
    ).toBeNull();
  });
});

describe('a capture’s holders', () => {
  const identity = { provider: 'slack', externalId: 'C0LARK5PUR/1793136000.000100' };

  it('asks the index for notes declaring capture/v1 with the message’s provider and id', () => {
    const { sql, parameters } = compileCaptureHoldersQuery(identity);
    expect(sql.startsWith('/* captures */')).toBe(true);
    expect(parameters).toEqual(['capture/v1', 'slack', 'C0LARK5PUR/1793136000.000100']);
  });

  it('reads a note as this capture only when all three say so', () => {
    const held = {
      atlas_import: 'capture/v1',
      provider: 'slack',
      external_id: identity.externalId,
    };
    expect(holdsCapture(held, identity)).toBe(true);
    expect(holdsCapture({ ...held, atlas_import: 'meeting/v1' }, identity)).toBe(false);
    expect(holdsCapture({ ...held, provider: 'gemini' }, identity)).toBe(false);
    expect(holdsCapture({ ...held, external_id: 'C0LARK5PUR/1793136000.000200' }, identity)).toBe(
      false,
    );
  });
});
