import { describe, expect, it } from 'vitest';
import { slackToBlocks } from './capture-mrkdwn.ts';
import type { MdBlock, MdLink, MdPhrasing } from './capture-tree.ts';

/*
 * Third attack on PR #615 (#103): a link the mapper writes opens the address
 * the sender sent (`tokenNode`: "the link opens the address it means"). Its
 * address is percent-encoded so markdown and the index read it as written
 * (`encodeAddress`), and a browser must still open that same place: the
 * encoded address parses, by WHATWG's rules, to the host and port the sent
 * one does. All addresses are made up.
 */

function linksOf(nodes: readonly (MdBlock | MdPhrasing)[]): MdLink[] {
  return nodes.flatMap((node): MdLink[] => {
    if (node.type === 'link') return [node, ...linksOf(node.children)];
    return 'children' in node ? linksOf(node.children as readonly (MdBlock | MdPhrasing)[]) : [];
  });
}

const where = (address: string) => {
  const url = new URL(address);
  return { protocol: url.protocol, host: url.host, username: url.username };
};

describe('a link opens the host the sender sent', () => {
  it.each([
    ['an IPv6 literal, bare', 'see http://[::1]/status now', 'http://[::1]/status'],
    [
      'an IPv6 literal with a port, in Slack’s brackets',
      '<http://[::1]:8080/x|status>',
      'http://[::1]:8080/x',
    ],
    [
      'an IPv6 literal in a Slack link labelled with itself',
      '<https://[2001:db8::1]/>',
      'https://[2001:db8::1]/',
    ],
    ['a port', 'see http://example.com:8080/p now', 'http://example.com:8080/p'],
    ['user info', 'see http://mara@example.com/ now', 'http://mara@example.com/'],
    ['a name beyond ASCII', 'see http://exämple.com/ now', 'http://exämple.com/'],
  ])('%s', (_, message, sent) => {
    const [only] = linksOf(slackToBlocks(message));
    expect(only, 'a link').toBeDefined();
    expect(() => new URL(only!.url), `${only!.url} does not parse`).not.toThrow();
    expect(where(only!.url)).toEqual(where(sent));
  });
});
