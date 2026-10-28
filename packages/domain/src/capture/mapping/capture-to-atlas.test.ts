import { describe, expect, it } from 'vitest';
import { SLACK_PERMALINK, slackCapture, slackSource } from '../../testing/slack-capture.ts';
import { readCapture } from './capture-payload.ts';
import { CaptureRefusedError } from './capture-refusal.ts';
import { captureFile, isNamedForKey, mapCapture, numberedCapturePath } from './capture-to-atlas.ts';

const LA = { timeZone: 'America/Los_Angeles' };

describe('mapCapture: a Slack message as its Inbox file (#103)', () => {
  it('writes a task: frontmatter saying where it came from, the message, its thread and its files', () => {
    const file = mapCapture(slackCapture(), LA);
    expect(file.path).toBe(
      'Inbox/Captures/Can you send the Larkspur renewal by Friday cc @Tobias Fenn (slack 2db9a3ee76a9e132).md',
    );
    expect(file.content).toBe(
      [
        '---',
        'type: task',
        'status: inbox',
        'atlas_import: capture/v1',
        'provider: slack',
        "external_id: 'C0LARK5PUR/1793136000.000100'",
        `source: '${SLACK_PERMALINK}'`,
        "author: 'Mara Quill'",
        "author_email: 'mara.quill@example.com'",
        "channel: '#larkspur-payroll'",
        "sent_at: '2026-10-27T21:20:00.000Z'",
        '---',
        '',
        `> **Mara Quill** · 2026-10-27 14:20 · [Open in Slack](${SLACK_PERMALINK})`,
        '>',
        '> Can you send the **Larkspur** renewal by Friday? cc @Tobias Fenn',
        '',
        '^m1793136000-000100',
        '',
        '## Thread',
        '',
        '> **Tobias Fenn** · 2026-10-27 14:25 · [Open in Slack](https://larkspur.slack.com/archives/C0LARK5PUR/p1793136300000200?thread_ts=1793136000.000100)',
        '>',
        '> On it.',
        '',
        '^r1793136300-000200',
        '',
        '## Attachments',
        '',
        '- [renewal.pdf](https://files.slack.com/files-pri/T0LARK/renewal.pdf)',
        '',
      ].join('\n'),
    );
    expect(file).toMatchObject({
      kind: 'task',
      provider: 'slack',
      externalId: 'C0LARK5PUR/1793136000.000100',
      title: 'Can you send the Larkspur renewal by Friday? cc @Tobias Fenn',
      commitMessage:
        'Capture: Can you send the Larkspur renewal by Friday? cc @Tobias Fenn (slack)',
    });
  });

  it('writes a note without the task’s type and status', () => {
    const { content } = mapCapture(slackCapture({ kind: 'note' }), LA);
    expect(content.startsWith('---\natlas_import: capture/v1\n')).toBe(true);
    expect(content).not.toContain('status:');
  });

  it('writes the same bytes every time for the same message: no clock, no chance', () => {
    expect(mapCapture(slackCapture(), LA)).toEqual(mapCapture(slackCapture(), LA));
  });

  it('shows times in UTC when no zone is given, and refuses a zone that is not one', () => {
    expect(mapCapture(slackCapture()).content).toContain('· 2026-10-27 21:20 ·');
    expect(() => mapCapture(slackCapture(), { timeZone: 'Mars/Olympus' })).toThrow(
      CaptureRefusedError,
    );
    expect(() => mapCapture(slackCapture(), { timeZone: 'Mars/Olympus' })).toThrow(
      /timeZone: "Mars\/Olympus" is not a time zone/,
    );
  });

  it('links an author to their Person note when the vault knows them', () => {
    const personFor = ({ email }: { email: string | null }) =>
      email === 'mara.quill@example.com' ? 'Mara Quill' : null;
    const { content } = mapCapture(slackCapture(), { ...LA, personFor });
    expect(content).toContain("author: '[[Mara Quill]]'");
    expect(content).toContain('> **[[Mara Quill]]** · 2026-10-27 14:20');
    expect(content).toContain('> **Tobias Fenn** · 2026-10-27 14:25');
  });

  it.each([['People/Odd]] name'], ['Mara|alias'], ['Mara#Heading'], ['']])(
    'writes the name instead of a link target %j that would break the link',
    (target) => {
      const { content } = mapCapture(slackCapture(), { personFor: () => target });
      expect(content).toContain("author: 'Mara Quill'");
    },
  );

  it('escapes an author’s name in the body and quotes it in the frontmatter', () => {
    const author = { name: "Mara 'Q' [[Quill]] #ops", email: null };
    const { content } = mapCapture(slackCapture({ source: slackSource({ author }) }));
    expect(content).toContain("author: 'Mara ''Q'' ((Quill)) #ops'");
    expect(content).toContain("> **Mara 'Q' \\[\\[Quill\\]\\] \\#ops** ·");
    expect(content).not.toContain('author_email');
  });

  it('names the channel by its id when it has no name, as a direct message has none', () => {
    const channel = { id: 'D0MARAQ111' };
    const url = SLACK_PERMALINK.replace('C0LARK5PUR', 'D0MARAQ111');
    const { content, externalId } = mapCapture(
      slackCapture({ source: slackSource({ channel, url }), thread: [] }),
    );
    expect(content).toContain("channel: 'D0MARAQ111'");
    expect(externalId).toBe('D0MARAQ111/1793136000.000100');
  });

  it('writes a reply with no permalink without a link', () => {
    const thread = [{ ts: '1793136300.000200', author: { name: 'Tobias Fenn' }, text: 'On it.' }];
    const { content } = mapCapture(slackCapture({ thread }));
    expect(content).toContain(
      '> **Tobias Fenn** · 2026-10-27 21:25\n>\n> On it.\n\n^r1793136300-000200',
    );
  });

  it('writes a message of attachments alone as its header and its files', () => {
    const { content, title } = mapCapture(slackCapture({ text: '', thread: [] }));
    expect(content).toContain(
      `[Open in Slack](${SLACK_PERMALINK})\n\n^m1793136000-000100\n\n## Attachments`,
    );
    expect(content).not.toContain('## Thread');
    expect(title).toBe('Slack message from Mara Quill');
  });

  it('writes no attachments section when there are none', () => {
    expect(mapCapture(slackCapture({ attachments: [] })).content).not.toContain('## Attachments');
  });
});

describe('a capture’s title and path', () => {
  const titled = (fields: Record<string, unknown>) =>
    captureFile(readCapture(slackCapture(fields)));

  it('takes the title asked for over the message', () => {
    expect(titled({ title: 'Send the renewal' }).path).toBe(
      'Inbox/Captures/Send the renewal (slack 2db9a3ee76a9e132).md',
    );
  });

  it('takes the first line with words in it, formatting dropped', () => {
    expect(titled({ text: '\n  \n*Payroll* run\nsecond line' }).title).toBe('Payroll run');
  });

  it('cuts a long first line at a word, under 80 characters', () => {
    const words = Array.from({ length: 30 }, (_, at) => `word${at}`).join(' ');
    const { title } = titled({ text: words });
    expect([...title].length).toBeLessThanOrEqual(81);
    expect(title.endsWith('…')).toBe(true);
    expect(words.startsWith(title.slice(0, -1))).toBe(true);
  });

  it('cuts a long line with no spaces where it reaches 80 characters', () => {
    expect(titled({ text: 'x'.repeat(200) }).title).toBe(`${'x'.repeat(80)}…`);
  });

  it('keeps a title that would make a path, a link or a hidden file out of the file name', () => {
    expect(titled({ title: '../.secret/[[x]] #y ^z: a|b' }).path).toBe(
      'Inbox/Captures/secret x y z a b (slack 2db9a3ee76a9e132).md',
    );
  });

  it('names a note after a link’s address with its entities read', () => {
    const { title, path } = titled({ text: '<https://example.com/?a=1&amp;b=2>' });
    expect(title).toBe('https://example.com/?a=1&b=2');
    expect(path).not.toContain('&amp;');
  });

  it('names a title that cleans away to nothing as a Slack message', () => {
    expect(titled({ title: '///' }).path).toBe(
      'Inbox/Captures/Slack message (slack 2db9a3ee76a9e132).md',
    );
  });

  it('ends every path of one message in its key, whatever its title, and another message’s in its own', () => {
    const other = SLACK_PERMALINK.replace('p1793136000000100', 'p1793136000000200');
    const second = titled({ source: slackSource({ ts: '1793136000.000200', url: other }) });
    const retitled = titled({ title: 'Renewal, from Slack' });
    expect(retitled.keyEnding).toBe(titled({}).keyEnding);
    expect(retitled.path.endsWith(titled({}).keyEnding)).toBe(true);
    expect(second.keyEnding).not.toBe(titled({}).keyEnding);
    expect(second.path).not.toBe(titled({}).path);
  });

  it('keeps a file name of a very long title within 255 bytes', () => {
    const { path, keyEnding } = titled({ title: '\u7A0E'.repeat(200) });
    const name = path.slice('Inbox/Captures/'.length);
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(255);
    expect(name.endsWith(keyEnding)).toBe(true);
  });
});

describe('a capture’s key in its file name (attack on PR #615)', () => {
  const file = mapCapture(slackCapture());

  it('is 64 bits of the key: 16 hex digits', () => {
    expect(file.keyEnding).toMatch(/^ \(slack [0-9a-f]{16}\)\.md$/);
  });

  it('numbers a path after a clash, inside the name’s 255 bytes however long the title', () => {
    expect(numberedCapturePath(file, 2)).toBe(file.path.replace(').md', ' 2).md'));
    const long = mapCapture(slackCapture({ title: '\u7A0E'.repeat(200) }));
    const name = numberedCapturePath(long, 99).split('/').at(-1) ?? '';
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(255);
  });

  it('knows its own names, numbered or not, in any case, and no other', () => {
    const name = (path: string) => path.split('/').at(-1) ?? '';
    expect(isNamedForKey(name(file.path), file.keyEnding)).toBe(true);
    expect(isNamedForKey(name(file.path).toUpperCase(), file.keyEnding)).toBe(true);
    expect(isNamedForKey(name(numberedCapturePath(file, 12)), file.keyEnding)).toBe(true);
    expect(isNamedForKey(`x${file.keyEnding.replace(').md', ' two).md')}`, file.keyEnding)).toBe(
      false,
    );
    expect(isNamedForKey(`x${file.keyEnding.replace(').md', ').md.bak')}`, file.keyEnding)).toBe(
      false,
    );
    expect(
      isNamedForKey(name(mapCapture(slackCapture({ text: 'other' }), {}).path), file.keyEnding),
    ).toBe(true);
  });

  it('never names a file with nothing before its key, nor a space', () => {
    // One grapheme too long for the name, and a title that cleans away to nothing.
    for (const title of [`e${'\u0301'.repeat(300)}`, '...']) {
      const name = mapCapture(slackCapture({ title })).path.split('/').at(-1) ?? '';
      expect(name).toMatch(/^\S/);
      expect(name.startsWith('Slack message (slack ')).toBe(true);
    }
  });
});
