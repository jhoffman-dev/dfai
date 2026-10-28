import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mapGranolaNote, mapMeeting } from '@dfai/domain';
import { codeNodeScript } from './code-node.ts';

/*
 * Adversarial (P28-09). ADR-0034's two writers of one Granola note are the
 * app's pull, in Tauri's macOS webview (JavaScriptCore), and n8n's Code node
 * (Node, V8); they must write the same bytes, or the vault gets a sync
 * conflict copy. The mapper's INSTANT pattern accepts strings whose reading
 * Date.parse leaves to the engine: lowercase `t`/`z` (RFC 3339 allows them;
 * JavaScriptCore answers NaN) and a 60th second (V8 answers NaN,
 * JavaScriptCore the next minute). Runs where macOS's `jsc` shell is.
 */

const JSC = '/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc';
const OPTIONS = {
  timeZone: 'America/Los_Angeles',
  selfEmails: ['mara.quill@example.com'],
  groupAddresses: [],
};

const NOTE = {
  id: 'not_4kTq2mWxLp4Rz7',
  object: 'note',
  owner: { name: 'Mara Quill', email: 'mara.quill@example.com' },
  title: 'Larkspur Payroll renewal',
  web_url: 'https://notes.granola.ai/d/0b6c1d2e',
  attendees: [],
  summary_text: 'Agreed.',
  summary_markdown: null,
  private_notes_text: null,
  private_notes_markdown: null,
  // The recording started 25 minutes after the calendar's time.
  transcript: [
    {
      speaker: { source: 'speaker', name: 'Tobias Fenn' },
      text: 'Hello.',
      start_time: '2026-10-06T17:25:00Z',
      end_time: '2026-10-06T17:25:02Z',
    },
  ],
};

const scheduled = (start: string) => ({
  ...NOTE,
  calendar_event: {
    event_title: null,
    invitees: [],
    organiser: null,
    calendar_event_id: null,
    scheduled_start_time: start,
    scheduled_end_time: null,
  },
});

const GRANOLA_RUN = `const OPTIONS = ${JSON.stringify(OPTIONS)};\nreturn mapGranolaNote($json, OPTIONS);`;
const MEETING_RUN = `return mapMeeting($json, { timeZone: '${OPTIONS.timeZone}', groupAddresses: [] });`;

/** The compiled Code-node script run under JavaScriptCore, each note's file or refusal. */
function inJavaScriptCore(notes: readonly unknown[], run = GRANOLA_RUN): unknown[] {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-jsc-'));
  const script = codeNodeScript(run);
  const driver = [
    `function mapInNode($json) {\n${script}\n}`,
    `const notes = ${JSON.stringify(notes)};`,
    'print(JSON.stringify(notes.map((note) => { try { return mapInNode(note); } catch (error) { return `${error.name}: ${error.message}`; } })));',
  ].join('\n');
  const file = join(dir, 'driver.js');
  try {
    writeFileSync(file, driver);
    return JSON.parse(execFileSync(JSC, [file], { encoding: 'utf8' })) as unknown[];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function inApp(note: unknown): unknown {
  try {
    return { ...mapGranolaNote(note, OPTIONS) };
  } catch (error) {
    return `${(error as Error).name}: ${(error as Error).message}`;
  }
}

describe.skipIf(!existsSync(JSC))('a Granola note mapped in the webview’s engine', () => {
  it.each([
    ['a lowercase t and z (RFC 3339 §5.6)', '2026-10-06t17:00:00z'],
    ['a 60th second', '2026-10-06T17:00:60Z'],
    ['30 February', '2026-02-30T17:00:00Z'],
    ['29 February in a leap year', '2028-02-29T17:00:00Z'],
    ['a fraction finer than a millisecond', '2026-10-06T17:00:00.9999999Z'],
    ['a half-hour offset', '2026-10-06T22:30:00+05:30'],
    ['an offset of 24 hours', '2026-10-06T17:00:00+24:00'],
  ])('with %s is written byte for byte as Node writes it', (_, start) => {
    const note = scheduled(start);
    const [webview] = inJavaScriptCore([note]);
    expect(webview).toEqual(inApp(note));
  });
});

describe.skipIf(!existsSync(JSC))('a meeting’s instant mapped in the webview’s engine', () => {
  const MEETING = {
    title: 'Larkspur Payroll weekly sync',
    source: 'gemini',
    sourceId: 'doc-7f3a',
    summary: 'Agreed.',
  };
  function inNode(meeting: unknown): unknown {
    try {
      return {
        ...mapMeeting(meeting as never, { timeZone: OPTIONS.timeZone, groupAddresses: [] }),
      };
    } catch (error) {
      return `${(error as Error).name}: ${(error as Error).message}`;
    }
  }

  it.each([
    ['a 60th second', '2026-10-06T17:00:60Z'],
    ['a lowercase t and z', '2026-10-06t17:00:00z'],
    ['an offset with no colon', '2026-10-06 17:00:00-0700'],
  ])('with %s is written byte for byte as Node writes it', (_, date) => {
    const meeting = { ...MEETING, date };
    const [webview] = inJavaScriptCore([meeting], MEETING_RUN);
    expect(webview).toEqual(inNode(meeting));
  });
});

describe.skipIf(!existsSync(JSC))('running a script in the webview’s engine', () => {
  // Issue #397: every run left its folder behind, 230 of them a night.
  const scratch = () => readdirSync(tmpdir()).filter((name) => name.startsWith('atlas-jsc-'));

  it('leaves no folder behind in the temp folder', () => {
    const before = scratch();
    inJavaScriptCore([scheduled('2026-10-06T17:00:00Z')]);
    expect(scratch()).toEqual(before);
  });
});

describe.skipIf(!existsSync(JSC))(
  'an owner’s address compared in the webview’s engine (#199)',
  () => {
    // JavaScriptCore's shell has no URL: the mapper reads a domain's punycode form itself.
    const SELF_RUN = (selfEmails: readonly string[]) =>
      `return mapGranolaNote($json, ${JSON.stringify({ ...OPTIONS, selfEmails })});`;
    const spoken = {
      ...NOTE,
      transcript: [
        {
          speaker: { source: 'speaker', attribution: 'me' },
          text: 'Hello.',
          start_time: '2026-10-06T17:25:00Z',
          end_time: '2026-10-06T17:25:02Z',
        },
      ],
    };

    it.each([
      [
        'a Unicode domain against its punycode form',
        'Mara@Bücher.example',
        'mara@xn--bcher-kva.example',
      ],
      [
        'a punycode domain against its Unicode form',
        'mara@xn--bcher-kva.example.',
        'mara@bücher.example',
      ],
      [
        'a decomposed local part against a composed one',
        'rén@日本語.example',
        'Rén <rén@xn--wgv71a119e.example>',
      ],
    ])('names the owner You for %s, byte for byte as Node does', (_, owner, self) => {
      const note = { ...spoken, owner: { name: 'Mara Quill', email: owner } };
      const [webview] = inJavaScriptCore([note], SELF_RUN([self]));
      const inNode = { ...mapGranolaNote(note, { ...OPTIONS, selfEmails: [self] }) };
      expect(webview).toEqual(inNode);
      expect(inNode.content).toContain('**You** [');
    });
  },
);
