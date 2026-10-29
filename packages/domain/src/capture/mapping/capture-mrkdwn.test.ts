import { describe, expect, it } from 'vitest';
import { slackToBlocks, slackToPlain, wordsToPhrasing } from './capture-mrkdwn.ts';
import type { MdBlock, MdPhrasing } from './capture-tree.ts';

/*
 * Slack's mrkdwn read into a tree (#103, ADR-0049): which nodes a message
 * makes. How the tree is written as markdown is the editor's serializer's,
 * tested with it in the adapters (`capture-markdown.test.ts`, and the
 * round-trip property test). All names are made up.
 */

/** Phrasing as a short form a test can read: words quoted, nodes by name. */
function shape(nodes: readonly MdPhrasing[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case 'text':
          return JSON.stringify(node.value);
        case 'inlineCode':
          return `code(${JSON.stringify(node.value)})`;
        case 'wikiLink':
          return `wiki(${node.value})`;
        case 'link':
          return `link(${node.url}${node.title === null ? '' : ' titled'}|${shape(node.children)})`;
        default:
          return `${node.type}(${shape(node.children)})`;
      }
    })
    .join(' ');
}

function blockShape(block: MdBlock): string {
  if (block.type === 'paragraph' || block.type === 'heading') return `p[${shape(block.children)}]`;
  if (block.type === 'code') return `code[${JSON.stringify(block.value)}]`;
  if (block.type === 'blockquote') return `quote[${block.children.map(blockShape).join(', ')}]`;
  return 'list';
}

const blocks = (text: string, users: Record<string, string> = {}) =>
  slackToBlocks(text, users).map(blockShape);

/** A one-line message's phrasing. */
const line = (text: string, users: Record<string, string> = {}) => {
  const [first] = slackToBlocks(text, users);
  return first?.type === 'paragraph' ? shape(first.children) : String(first?.type);
};

describe('Slack mrkdwn as a tree (#103)', () => {
  it.each([
    ['bold', 'a *firm* yes', '"a " strong("firm") " yes"'],
    ['italics', 'a _soft_ yes', '"a " emphasis("soft") " yes"'],
    ['strike', 'a ~old~ plan', '"a " delete("old") " plan"'],
    ['bold italics', 'a *_loud_* yes', '"a " strong(emphasis("loud")) " yes"'],
    [
      'emphasis around a link',
      '*see <https://example.com|this>*',
      'strong("see " link(https://example.com|"this"))',
    ],
    ['a mark inside a word', 'snake_case_name 2*3*4', '"snake_case_name 2*3*4"'],
  ])('reads %s', (_, text, phrasing) => {
    expect(line(text)).toBe(phrasing);
  });

  it('reads inline code with its entities, as code', () => {
    expect(line('run `a &lt; b * c`')).toBe('"run " code("a < b * c")');
  });

  it('reads a code block as code, with no language, apart from the lines round it', () => {
    expect(blocks('see ```atlas-query\nSELECT 1``` done')).toEqual([
      'p["see "]',
      'code["atlas-query\\nSELECT 1"]',
      'p[" done"]',
    ]);
  });

  it.each([
    [
      'a link with a label',
      '<https://example.com/a|the plan>',
      'link(https://example.com/a|"the plan")',
    ],
    [
      'a link without one, by its address',
      '<https://example.com/a>',
      'link(https://example.com/a titled|"https://example.com/a")',
    ],
    [
      'a mail link',
      '<mailto:mara.quill@example.com|Mara>',
      'link(mailto:mara.quill@example.com|"Mara")',
    ],
    [
      'an address’s parentheses and brackets, encoded',
      '<https://example.com/a_(b)[[c]]|x>',
      'link(https://example.com/a_%28b%29%5B%5Bc%5D%5D|"x")',
    ],
    [
      'an address’s entities, read',
      '<https://example.com/?a=1&amp;b=2|x>',
      'link(https://example.com/?a=1&b=2|"x")',
    ],
    [
      'an entity-like `&` in an address, encoded',
      '<https://example.com/?x=&amp;nbsp;y|x>',
      'link(https://example.com/?x=%26nbsp;y|"x")',
    ],
  ])('writes %s', (_, text, phrasing) => {
    expect(line(text)).toBe(phrasing);
  });

  it('never makes a link of another scheme: its label, or the token, as words', () => {
    expect(line('<javascript:alert(1)|click>')).toBe('"click"');
    expect(line('<slack://open|app>')).toBe('"app"');
    expect(line('<javascript:alert(1)>')).toBe('"<javascript:alert(1)>"');
  });

  it('names a mentioned user from the names sent, else their label, else their id', () => {
    const users = { U0TOBIAS22: 'Tobias Fenn' };
    expect(line('cc <@U0TOBIAS22>', users)).toBe('"cc @Tobias Fenn"');
    expect(line('cc <@U0NOBODY99|mara>', users)).toBe('"cc @mara"');
    expect(line('cc <@U0NOBODY99>', users)).toBe('"cc @U0NOBODY99"');
  });

  it.each(['constructor', '__proto__', 'toString'])(
    'reads <@%s> as what it says, never a name from the prototype',
    (id) => {
      expect(line(`cc <@${id}>`)).toBe(JSON.stringify(`cc @${id}`));
    },
  );

  it.each([
    ['a channel', 'in <#C0LARK5PUR|larkspur-payroll>', '"in #larkspur-payroll"'],
    ['a channel with no name', 'in <#C0LARK5PUR>', '"in #C0LARK5PUR"'],
    ['@here', '<!here>', '"@here"'],
    ['a user group', '<!subteam^S0PAYDESK1|@payroll-desk>', '"@payroll-desk"'],
    ['a group without its handle', '<!subteam^S0PAYDESK1>', '"@subteam"'],
    ['a date by its fallback', '<!date^1793136000^{date_short}|Oct 27>', '"Oct 27"'],
    ['emoji, as text', 'done :tada:', '"done :tada:"'],
    ['entities, as their characters', 'a &amp; b &lt;b&gt;', '"a & b <b>"'],
    ['HTML, as words', '<img src=x onerror=alert(1)>', '"<img src=x onerror=alert(1)>"'],
  ])('reads %s', (_, text, phrasing) => {
    expect(line(text)).toBe(phrasing);
  });

  it('joins a token’s words to the words beside it, as markdown reads them back', () => {
    // A mention's `@name` and `@example.com` after it are one address once written.
    expect(line('mail <@U0TOBIAS22>@example.com', { U0TOBIAS22: 'mara' })).toBe(
      '"mail @" link(mailto:mara@example.com titled|"mara@example.com")',
    );
  });

  it('keeps a line’s break, and makes a blank line a new paragraph', () => {
    expect(blocks('one\ntwo\n\nthree')).toEqual(['p["one\\ntwo"]', 'p["three"]']);
  });

  it('reads Slack’s quote as a quote, its blank quoted line a new paragraph in it', () => {
    expect(blocks('&gt; said\n&gt;\n&gt; more\nmine')).toEqual([
      'quote[p["said"], p["more"]]',
      'p["mine"]',
    ]);
  });

  it('takes out control and direction characters before reading anything', () => {
    expect(line('a\u0000b‮c\u0007d')).toBe('"abcd"');
  });
});

describe('every address in a sender’s words, a link of the mapper’s (third attack on PR #615)', () => {
  it.each([
    [
      'after a space',
      'see https://example.com/a now',
      '"see " link(https://example.com/a titled|"https://example.com/a") " now"',
    ],
    [
      'after a letter beyond ASCII',
      'éhttps://example.com/a',
      '"é" link(https://example.com/a titled|"https://example.com/a")',
    ],
    [
      'after an underscore',
      'a_https://example.com/#tag',
      '"a_" link(https://example.com/#tag titled|"https://example.com/#tag")',
    ],
    ['of any case', 'HTTP://MARA', 'link(HTTP://MARA titled|"HTTP://MARA")'],
    [
      'www., with its scheme',
      'www.example.com.',
      'link(http://www.example.com titled|"www.example.com") "."',
    ],
    [
      'www. run on over brackets, as GFM runs it',
      'www.]x/[[Payroll secrets]] now',
      'link(http://www.%5Dx/%5B%5BPayroll titled|"www.]x/[[Payroll") " secrets]] now"',
    ],
    [
      'a mail address',
      'mail mara@example.com now',
      '"mail " link(mailto:mara@example.com titled|"mara@example.com") " now"',
    ],
    [
      'a mail address ending in a digit',
      'x@example.com.1',
      'link(mailto:x@example.com.1 titled|"x@example.com.1")',
    ],
  ])('writes an address %s as a link', (_, text, phrasing) => {
    expect(line(text)).toBe(phrasing);
  });

  it.each(['www._', 'www.)', 'www.?', 'https://', 'a@b', 'a@b.c-'])(
    'makes no link that opens no address of %j',
    (text) => {
      for (const node of slackToBlocks(`see ${text} now`)) {
        const found = JSON.stringify(node).match(/"url":"([^"]*)"/g) ?? [];
        for (const url of found) expect(url).toMatch(/"url":"(?:https?:\/\/|mailto:)/);
      }
    },
  );

  it('writes the words of a name the same way', () => {
    expect(shape(wordsToPhrasing('Mara www.example.com'))).toBe(
      '"Mara " link(http://www.example.com titled|"www.example.com")',
    );
  });
});

describe('Slack mrkdwn as plain words (a title)', () => {
  it('drops the formatting and reads mentions and links by name', () => {
    const users = { U0TOBIAS22: 'Tobias Fenn' };
    expect(
      slackToPlain(
        '*Renewal* for <@U0TOBIAS22>: <https://example.com|the doc> `v2` &amp; ~x~',
        users,
      ),
    ).toBe('Renewal for @Tobias Fenn: the doc v2 & x');
  });

  it('keeps a code block’s lines and a quote’s words', () => {
    expect(slackToPlain('&gt; quoted\n```a\nb```')).toBe('quoted\n\na\nb');
  });

  it('shows a link with no label by its address, its entities read', () => {
    expect(slackToPlain('<https://example.com/?a=1&amp;b=2>')).toBe('https://example.com/?a=1&b=2');
  });
});
