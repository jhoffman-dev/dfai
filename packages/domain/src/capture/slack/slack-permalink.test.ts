import { describe, expect, it } from 'vitest';
import { readSlackPermalink } from './slack-permalink.ts';

/* #105: which pasted text is a Slack message link, and which message it names. */

const BASE = 'https://larkspur.slack.com/archives/C0LARK5PUR/p1793136000000100';

describe('a Slack message link', () => {
  it('names its channel and its ts, the dot put back', () => {
    expect(readSlackPermalink(BASE)).toEqual({
      url: BASE,
      channel: 'C0LARK5PUR',
      ts: '1793136000.000100',
      threadTs: null,
    });
  });

  it('to a reply names its thread too, wherever thread_ts sits in the query', () => {
    for (const query of [
      '?thread_ts=1793135900.000050&cid=C0LARK5PUR',
      '?cid=C0LARK5PUR&thread_ts=1793135900.000050',
    ]) {
      expect(readSlackPermalink(`${BASE}${query}`)?.threadTs).toBe('1793135900.000050');
    }
  });

  it('is read trimmed, and on an Enterprise Grid domain or slack.com alone', () => {
    expect(readSlackPermalink(`  ${BASE}\n`)?.url).toBe(BASE);
    expect(
      readSlackPermalink(
        'https://larkspur.enterprise.slack.com/archives/C0LARK5PUR/p1793136000000100',
      )?.channel,
    ).toBe('C0LARK5PUR');
  });

  it('is not a thread_ts that is not one, nor a param merely ending in it', () => {
    expect(readSlackPermalink(`${BASE}?thread_ts=17931359`)?.threadTs).toBeNull();
    expect(readSlackPermalink(`${BASE}?xthread_ts=1793135900.000050`)?.threadTs).toBeNull();
  });

  it('is nothing else: other sites, other schemes, a channel, words around it', () => {
    for (const text of [
      'https://larkspur.slack.com.example.com/archives/C0LARK5PUR/p1793136000000100',
      'http://larkspur.slack.com/archives/C0LARK5PUR/p1793136000000100',
      'https://larkspur.slack.com/archives/C0LARK5PUR',
      'https://larkspur.slack.com/archives/C0LARK5PUR/p17931360',
      `see ${BASE}`,
      `${BASE} please`,
      `${BASE}?a=[[x]]`,
      `${BASE}?${'a'.repeat(2_000)}`,
      '',
    ]) {
      expect(readSlackPermalink(text), text).toBeNull();
    }
  });
});
