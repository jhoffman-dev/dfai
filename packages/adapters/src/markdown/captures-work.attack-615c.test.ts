import { describe, expect, it } from 'vitest';
import { linkifyWords, mapCapture as mapDomainCapture } from '@dfai/domain';
import { countedWork, slackCapture } from '@dfai/domain/testing';
import { writeCaptureMarkdown } from './capture-markdown.ts';

/*
 * Third attack on PR #615 (#103): a capture's work bounded for the worst
 * messages within MAX_MESSAGE_LENGTH. Counted, never timed (#385): a test
 * compares the work of two sizes of one input. All names are made up.
 */

const mapped = (text: string) => () =>
  mapDomainCapture(slackCapture({ text, thread: [], attachments: [] }), {
    writeMarkdown: writeCaptureMarkdown,
    timeZone: 'UTC',
  });

describe('writing a capture takes work in step with its length', () => {
  // `*a*` side by side is one bold after another. The writer's alternating
  // marker (emphasis-handlers.ts) walks back over every earlier neighbour,
  // each by `indexOf`, for each node: cubic, and its recursion overflows the
  // stack near ten thousand neighbours — a 40,000-character message is
  // minutes of the app's thread, then a RangeError.
  it.each([
    ['bold', (count: number) => '*a*'.repeat(count)],
    ['bold and italic', (count: number) => '*a*_b_'.repeat(count)],
  ])('%s side by side: four times the marks, at most eight times the work', (_, message) => {
    const small = countedWork(mapped(message(250)));
    const large = countedWork(mapped(message(1000)));
    expect(large).toBeLessThan(small * 8);
  });

  it('a message of every other markup at the limit is linear too', () => {
    const message = (count: number) =>
      '<https://example.com|x> ^a <@U0TOBIAS22> &amp; `c` www.example.com a@b.co #ops\n'.repeat(
        count,
      );
    const small = countedWork(mapped(message(50)));
    const large = countedWork(mapped(message(200)));
    expect(large).toBeLessThan(small * 8);
  });
});

describe('linkifying words takes work in step with their length', () => {
  const N = 40_000;
  it.each([
    [
      'one long name before an `@` and an undotted domain',
      (n: number) => 'a'.repeat(n / 2) + '@' + 'b'.repeat(n / 2 - 1),
    ],
    [
      'names run up to one `@` again and again',
      (n: number) => ('a'.repeat(50) + '@').repeat(Math.floor(n / 51)),
    ],
    ['`www.` again and again', (n: number) => 'www.'.repeat(n / 4)],
    ['dotted domains with no name end', (n: number) => 'a@b.'.repeat(n / 4)],
  ])(
    '%s: four times the words, at most eight times the work, and six steps a character',
    (_, words) => {
      const small = countedWork(() => linkifyWords(words(N / 4)));
      const large = countedWork(() => linkifyWords(words(N)));
      expect(large).toBeLessThan(small * 8);
      expect(linkifyWords(words(N)).steps).toBeLessThanOrEqual(6 * words(N).length);
    },
  );

  // Counted work would be quadratic here only by how it counts a `slice`: the
  // engine shares the text, and a timed run at 640,000 characters is linear.
  it('an address of opening then closing brackets: six steps a character', () => {
    const words = `http://a.b/${'('.repeat(N / 2 - 6)}${')'.repeat(N / 2 - 6)}`;
    expect(linkifyWords(words).steps).toBeLessThanOrEqual(6 * words.length);
  });
});
