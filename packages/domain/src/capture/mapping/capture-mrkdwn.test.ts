import { describe, expect, it } from 'vitest';
import { escapeMarkdown, slackToMarkdown, slackToPlain } from './capture-mrkdwn.ts';

/** One line of a message, as markdown. */
const md = (text: string, users: Record<string, string> = {}) =>
  slackToMarkdown(text, users).join('\n');

describe('Slack mrkdwn as DFAI markdown (#103)', () => {
  it.each([
    ['bold', 'a *firm* yes', 'a **firm** yes'],
    ['italics', 'a _soft_ yes', 'a *soft* yes'],
    ['strike', 'a ~old~ plan', 'a ~~old~~ plan'],
    ['bold italics', 'a *_loud_* yes', 'a ***loud*** yes'],
    [
      'emphasis around a link',
      '*see <https://example.com|this>*',
      '**see [this](https://example.com)**',
    ],
  ])('reads %s', (_, slack, markdown) => {
    expect(md(slack)).toBe(markdown);
  });

  it('leaves a mark inside a word as the character it is', () => {
    expect(md('snake_case_name and 2*3*4')).toBe('snake\\_case\\_name and 2\\*3\\*4');
  });

  it('keeps inline code as written, its entities read back, never escaped', () => {
    expect(md('run `a &lt; b * c`')).toBe('run `a < b * c`');
  });

  it('fences inline code holding a backtick with a longer run', () => {
    expect(slackToMarkdown('x `` y', {})).toEqual(['x \\`\\` y']);
  });

  it('fences a code block on lines of its own, with no info string, longer than any run inside', () => {
    expect(slackToMarkdown('see ```atlas-query\nSELECT 1``` done', {})).toEqual([
      'see ',
      '```',
      'atlas-query',
      'SELECT 1',
      '```',
      ' done',
    ]);
    expect(slackToMarkdown('```a `` b```', {})).toEqual(['```', 'a `` b', '```']);
  });

  it('writes an empty code block as an empty fence', () => {
    expect(slackToMarkdown('``````', {})).toEqual(['```', '```']);
  });

  it.each([
    [
      'a link with a label',
      '<https://example.com/a|the plan>',
      '[the plan](https://example.com/a)',
    ],
    ['a bare link', '<https://example.com/a>', '[https\\://example.com/a](https://example.com/a)'],
    [
      'a mail link',
      '<mailto:mara.quill@example.com|Mara>',
      '[Mara](mailto:mara.quill@example.com)',
    ],
    [
      'parentheses in a link',
      '<https://example.com/a_(b)|x>',
      '[x](https://example.com/a_%28b%29)',
    ],
    [
      'a label with marks',
      '<https://example.com|[[Home]] *x*>',
      '[\\[\\[Home\\]\\] \\*x\\*](https://example.com)',
    ],
  ])('writes %s', (_, slack, markdown) => {
    expect(md(slack)).toBe(markdown);
  });

  it('percent-encodes what would make a wiki link, an embed or an end in a link’s address', () => {
    expect(md("<https://example.com/![[a]]'|see>")).toBe(
      '[see](https://example.com/%21%5B%5Ba%5D%5D%27)',
    );
    expect(md('<mailto:[[a]]@example.com>')).toBe(
      '[mailto:\\[\\[a\\]\\]@example.com](mailto:%5B%5Ba%5D%5D@example.com)',
    );
  });

  it('never writes a link that runs script or leaves the web', () => {
    expect(md('<javascript:alert(1)|click>')).toBe('click');
    expect(md('<slack://open|app>')).toBe('app');
    expect(md('<javascript:alert(1)>')).toBe('\\<javascript:alert(1)\\>');
  });

  it('writes a bare address as an explicit link, so no link read from words runs over the escapes after it', () => {
    expect(md('see https://example.com/a<b> and www.example.com')).toBe(
      'see [https\\://example.com/a](https://example.com/a)\\<b\\> and [www\\.example.com](http://www.example.com)',
    );
  });

  it('names a mentioned user from the names sent, else their label, else their id', () => {
    const users = { U0TOBIAS22: 'Tobias Fenn' };
    expect(md('cc <@U0TOBIAS22>', users)).toBe('cc @Tobias Fenn');
    expect(md('cc <@U0NOBODY99|mara>', users)).toBe('cc @mara');
    expect(md('cc <@U0NOBODY99>', users)).toBe('cc @U0NOBODY99');
  });

  it.each(['constructor', '__proto__', 'toString'])(
    'writes <@%s> as what it says, never a name from the prototype',
    (id) => {
      expect(md(`cc <@${id}>`)).toBe(`cc @${id.replace(/_/g, '\\_')}`);
    },
  );

  it('writes a channel as words, never a tag', () => {
    expect(md('in <#C0LARK5PUR|larkspur-payroll>')).toBe('in \\#larkspur-payroll');
    expect(md('in <#C0LARK5PUR>')).toBe('in \\#C0LARK5PUR');
  });

  it.each([
    ['@here', '<!here>', '@here'],
    ['@channel', '<!channel>', '@channel'],
    ['a user group', '<!subteam^S0PAYDESK1|@payroll-desk>', '@payroll-desk'],
    ['a group without its handle', '<!subteam^S0PAYDESK1>', '@subteam'],
    ['a date by its fallback', '<!date^1793136000^{date_short}|Oct 27>', 'Oct 27'],
  ])('writes %s by what Slack shows', (_, slack, markdown) => {
    expect(md(slack)).toBe(markdown);
  });

  it('keeps emoji shortcodes as text', () => {
    expect(md('done :tada: :+1:')).toBe('done :tada: :+1:');
  });

  it('reads the entities Slack writes, and escapes what they stand for', () => {
    expect(md('a &amp; b &lt;b&gt;bold&lt;/b&gt;')).toBe('a & b \\<b\\>bold\\</b\\>');
  });

  it('keeps an entity written as text from being read as its character', () => {
    expect(md('&amp;lt;script&amp;gt; &#60;')).toBe('\\&lt;script\\&gt; \\&\\#60;');
  });

  it('reads Slack’s quote as a quote', () => {
    expect(slackToMarkdown('&gt; said\n&gt;\nmine', {})).toEqual(['> said', '>', 'mine']);
  });

  it.each([
    ['a heading', '# Not a heading', '\\# Not a heading'],
    ['a tag', 'a #tag', 'a \\#tag'],
    ['a wiki link', '[[Secret]]', '\\[\\[Secret\\]\\]'],
    ['an embed', '![[Secret]]', '!\\[\\[Secret\\]\\]'],
    [
      'an image',
      '![x](https://example.com/p.png)',
      '!\\[x\\]([https\\://example.com/p.png](https://example.com/p.png))',
    ],
    ['a block id', 'mine ^t0001', 'mine \\^t0001'],
    ['a table row', '| a | b |', '\\| a \\| b \\|'],
    ['a checkbox', '- [ ] do', '- \\[ \\] do'],
    ['a callout', '[!warning] x', '\\[!warning\\] x'],
    ['a backslash undoing an escape', '\\[[x]]', '\\\\\\[\\[x\\]\\]'],
    ['a fence of tildes', '~~~', '\\~\\~\\~'],
    ['raw HTML', '<img src=x onerror=alert(1)>', '\\<img src=x onerror=alert(1)\\>'],
  ])('writes %s as words', (_, slack, markdown) => {
    expect(md(slack)).toBe(markdown);
  });

  it.each([['---'], ['  - - -'], ['==='], ['+++']])(
    'keeps the line %j from being a rule or a heading’s underline',
    (line) => {
      expect(md(`above\n${line}`).split('\n')[1]).toMatch(/^\s*\\[-=+]/);
    },
  );

  it('drops blank lines at either end and keeps those between', () => {
    expect(slackToMarkdown('\n\none\n\ntwo\n\n', {})).toEqual(['one', '', 'two']);
  });

  it('takes out control and direction characters before reading anything', () => {
    expect(md('a\u0000b\u202Ec\u0007d\r\ne')).toBe('abcd\ne');
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
    expect(slackToPlain('&gt; quoted\n```a\nb```', {})).toBe('quoted\n\na\nb');
  });
});

describe('escapeMarkdown', () => {
  it('escapes every character markdown or DFAI reads as more than itself, and nothing else', () => {
    expect(escapeMarkdown('\\`*_~[]<>#^| plain: words, 1. (x) &amp;')).toBe(
      '\\\\\\`\\*\\_\\~\\[\\]\\<\\>\\#\\^\\| plain: words, 1. (x) \\&amp;',
    );
  });
});
