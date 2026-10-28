import { describe, expect, it } from 'vitest';
import { slackCapture } from '../../testing/slack-capture.ts';
import { slackToMarkdown } from './capture-mrkdwn.ts';
import { mapCapture } from './capture-to-atlas.ts';

/*
 * Adversarial cases for the capture mapper (#103, attack on PR #615): each
 * test names one promise the mapper makes and an input that breaks it. All
 * names are made up.
 */

describe('a message within Slack’s 40,000 characters maps in linear time', () => {
  // bareAddress (capture-mrkdwn.ts:170-180) cuts one `)` per turn and splits the whole
  // address twice each turn, and TRAILING (:164) is tried from every place in a run of
  // dots: both quadratic. Measured at Slack's own limit: 39,000 `)` take 19 s, 19,000 `.)`
  // 10.7 s, 39,000 dots then a letter 2.4 s, so a thread of 25 holds the app for minutes.
  // Smaller inputs here keep a failing run short; linear, each maps in a few ms, so the
  // budget is 50 times what it needs.
  it.each([
    ['closing parentheses', `https://example.com/${')'.repeat(10_000)}`],
    ['dots and parentheses', `https://example.com/${'.)'.repeat(7_000)}`],
    ['dots, then a letter', `https://example.com/${'.'.repeat(20_000)}a`],
  ])(
    'an address followed by %s',
    (_, text) => {
      const started = performance.now();
      slackToMarkdown(text);
      expect(performance.now() - started).toBeLessThan(250);
    },
    60_000,
  );
});

describe('a file name never starts with a space', () => {
  // fitStem keeps whole graphemes; a title of one grapheme too long for the name keeps
  // none, and the `|| 'Slack message'` fallback (capture-to-atlas.ts:119) is applied
  // before the cut, so the name is ` (slack <hash>).md`.
  it('a title of one grapheme longer than the name allows', () => {
    const title = `e${'́'.repeat(300)}`;
    const name = mapCapture(slackCapture({ title })).path.split('/').at(-1) ?? '';
    expect(name).not.toMatch(/^\s/);
  });
});
