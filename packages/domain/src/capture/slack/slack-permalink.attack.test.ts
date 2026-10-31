import { describe, expect, it } from 'vitest';
import { readCapture } from '../mapping/capture-payload.ts';
import { readSlackPermalink } from './slack-permalink.ts';

/*
 * Attack on PR #631 (#105). readSlackPermalink promises "a link read here
 * is one a capture holds". A channel PERMALINK admits but CHANNEL_ID refuses
 * is offered, read through Slack, and then refused by the contract.
 */

describe('a link to a channel id the contract refuses', () => {
  it('is not read as a Slack message link', () => {
    const link = 'https://larkspur.slack.com/archives/AB/p1793136000000100';
    const read = readSlackPermalink(link);
    const capture = () =>
      readCapture({
        contract: 'capture/v1',
        kind: 'note',
        source: {
          provider: 'slack',
          channel: { id: 'AB' },
          ts: '1793136000.000100',
          url: link,
          author: { id: 'U0MARAQ111', name: 'Mara Quill', email: null },
        },
        text: 'Hello',
        thread: [],
        attachments: [],
        users: {},
      });
    expect(capture).toThrow();
    expect(read).toBeNull();
  });
});
