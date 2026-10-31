import { describe, expect, it } from 'vitest';
import { mapGranolaNote } from './granola-note.ts';
import { MeetingMappingError } from './meeting-mapping-error.ts';

/*
 * Adversarial (P28-09). The mapper promises to refuse only with a
 * MeetingMappingError, and to write a meeting on the day it happened. All
 * names here are made up.
 */

const OPTIONS = {
  timeZone: 'America/Los_Angeles',
  selfEmails: ['mara.quill@example.com'],
  groupAddresses: [],
};

const turn = (text: string, second: number) => ({
  speaker: { source: 'speaker', name: 'Tobias Fenn' },
  text,
  start_time: new Date(Date.UTC(2026, 9, 6, 17, 0, 0) + second * 1000).toISOString(),
  end_time: new Date(Date.UTC(2026, 9, 6, 17, 0, 0) + second * 1000 + 500).toISOString(),
});

const NOTE = {
  id: 'not_4kTq2mWxLp4Rz7',
  object: 'note',
  owner: { name: 'Mara Quill', email: 'mara.quill@example.com' },
  title: 'Larkspur Payroll renewal',
  web_url: 'https://notes.granola.ai/d/0b6c1d2e',
  calendar_event: null,
  attendees: [],
  summary_text: 'Agreed.',
  summary_markdown: null,
  private_notes_text: null,
  private_notes_markdown: null,
  transcript: [turn('Hello.', 1)],
};

const calendar = (start: string) => ({
  event_title: null,
  invitees: [],
  organiser: null,
  calendar_event_id: null,
  scheduled_start_time: start,
  scheduled_end_time: null,
});

/** What the mapper threw, or null. */
function thrownBy(map: () => unknown): unknown {
  try {
    map();
    return null;
  } catch (error) {
    return error;
  }
}

describe('a Granola note the mapper must refuse by name, never crash on', () => {
  // 0.7 s on a Mac, up to 3.5 s on a loaded 4-core CI runner (#648): the default 5 s is too close.
  it('maps, or refuses with a MeetingMappingError, 130,000 short timed turns (under the 5 MB transcript cap)', () => {
    // 130,000 "Ok." turns is ~390 KB of transcript text. `extreme` spreads every
    // turn's time into Math.min/Math.max, which overflows V8's argument stack
    // somewhere past ~120,000 and throws a RangeError instead.
    const transcript = Array.from({ length: 130_000 }, (_, at) => turn('Ok.', at));
    const thrown = thrownBy(() => mapGranolaNote({ ...NOTE, transcript }, OPTIONS));
    expect(thrown === null || thrown instanceof MeetingMappingError, String(thrown)).toBe(true);
  }, 15_000);
});

describe('a Granola instant naming a day the calendar does not have', () => {
  it.each([
    ['2026-02-30T17:00:00Z', '2026-03-02'],
    ['2026-02-29T17:00:00Z', '2026-03-01'],
  ])('%s is not written as the meeting of %s', (start, rolledOver) => {
    // INSTANT checks only the shape; V8's Date.parse then rolls the
    // impossible day into March, so n8n writes the meeting on a day it was not.
    // (JavaScriptCore, the app's webview, answers NaN for the same string.)
    const thrown = thrownBy(() =>
      mapGranolaNote({ ...NOTE, calendar_event: calendar(start) }, OPTIONS),
    );
    if (thrown !== null) {
      expect(thrown).toBeInstanceOf(MeetingMappingError);
      return;
    }
    const { content } = mapGranolaNote({ ...NOTE, calendar_event: calendar(start) }, OPTIONS);
    expect(content).not.toContain(`date: '${rolledOver}'`);
  });
});

describe('a refusal’s message, which n8n emails and the pull logs', () => {
  it('names the field and does not carry the meeting’s content', () => {
    // A vendor shape change (summary_markdown as an object) is refused with
    // `expected text, got ${JSON.stringify(value)}`: the whole summary, on one
    // line, with no field named.
    const content = 'Confidential renewal terms. '.repeat(40_000);
    const thrown = thrownBy(() =>
      mapGranolaNote({ ...NOTE, summary_markdown: { markdown: content } }, OPTIONS),
    );
    expect(thrown).toBeInstanceOf(MeetingMappingError);
    const { message } = thrown as MeetingMappingError;
    expect(message).not.toContain('Confidential renewal terms');
    expect(message).toMatch(/summary/);
  });
});
