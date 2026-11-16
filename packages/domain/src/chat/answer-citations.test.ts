import { describe, expect, it } from 'vitest';
import { citeAnswer, uncitedCount, type AnswerBlock } from './answer-citations.ts';
import { isWebAddress } from './answer-inline.ts';

/** Each block as `kind:citation`, the shape most rules are read in. */
const verdicts = (answer: string) =>
  citeAnswer(answer).map((block) => `${block.kind}:${block.citation}`);

const cites = (block: AnswerBlock | undefined) =>
  (block?.inline ?? []).filter((piece) => piece.kind === 'cite');

describe('citeAnswer: which blocks must cite (#37)', () => {
  it('passes a paragraph with a wiki link and flags one without', () => {
    expect(
      verdicts('Mara wants a rollback plan [[Kickoff#^t0003]].\n\nThe bank file is late.'),
    ).toEqual(['paragraph:cited', 'paragraph:uncited']);
  });

  it('judges each list item on its own', () => {
    expect(
      verdicts('- Chase the bank [[Chase the bank]]\n- Book the review\n* Ship it [[Ship]]'),
    ).toEqual(['item:cited', 'item:uncited', 'item:cited']);
  });

  it('reads ordered items, and keeps their markers', () => {
    const blocks = citeAnswer('1. First [[A]]\n2) Second');
    expect(blocks.map((block) => block.marker)).toEqual(['1.', '2)']);
    expect(blocks.map((block) => block.citation)).toEqual(['cited', 'uncited']);
  });

  it('takes a quote as one block, cited by a link on any of its lines', () => {
    expect(
      verdicts('> And the bank file needs a rollback plan.\n>\n> — Mara, [[Kickoff#^t0003]]'),
    ).toEqual(['quote:cited']);
    expect(verdicts('> Something somebody said.')).toEqual(['quote:uncited']);
  });

  it('exempts headings, rules and fenced code, which state nothing', () => {
    expect(verdicts('## Open loops\n\n---\n\n```\nnpm test\n```')).toEqual([
      'heading:exempt',
      'rule:exempt',
      'code:exempt',
    ]);
  });

  it('does not count a link inside fenced code, nor read the fence for links', () => {
    const blocks = citeAnswer('```md\nSee [[Kickoff]]\n```\n\nSo it is settled.');
    expect(blocks.map((block) => block.citation)).toEqual(['exempt', 'uncited']);
    expect(blocks[0]?.inline).toEqual([{ kind: 'code', text: 'See [[Kickoff]]' }]);
  });

  it('does not count a link inside a code span', () => {
    const [block] = citeAnswer('Write `[[Kickoff]]` to link it.');
    expect(block?.citation).toBe('uncited');
    expect(block?.inline).toContainEqual({ kind: 'code', text: '[[Kickoff]]' });
  });

  it('does not count an escaped link', () => {
    expect(verdicts('Type \\[[Kickoff]] for a link.')).toEqual(['paragraph:uncited']);
  });

  it('counts an embed as a citation, and follows it as a link', () => {
    const [block] = citeAnswer('The quote: ![[Kickoff#^t0003]]');
    expect(block?.citation).toBe('cited');
    expect(cites(block)).toEqual([{ kind: 'cite', link: '[[Kickoff#^t0003]]', label: 'Kickoff' }]);
  });

  it('does not count a web address as a citation', () => {
    expect(verdicts('See https://example.com/spec for it.')).toEqual(['paragraph:uncited']);
  });

  it('exempts a paragraph that leads into the list under it, not one before other text', () => {
    expect(verdicts('Three things are open:\n- One [[A]]\n- Two [[B]]')).toEqual([
      'paragraph:exempt',
      'item:cited',
      'item:cited',
    ]);
    expect(verdicts('Three things are open:\n\nNothing else.')).toEqual([
      'paragraph:uncited',
      'paragraph:uncited',
    ]);
  });

  it('exempts an item that leads into deeper items, but not into a sibling', () => {
    expect(verdicts('- Mara:\n  - Wants a plan [[K#^t1]]\n- Tobias:\n- Is away')).toEqual([
      'item:exempt',
      'item:cited',
      'item:uncited',
      'item:uncited',
    ]);
  });

  it('judges a table whole, by any link in it', () => {
    expect(verdicts('| Task | From |\n| --- | --- |\n| Chase | [[Kickoff]] |')).toEqual([
      'table:cited',
    ]);
    expect(verdicts('| Task |\n| --- |\n| Chase |')).toEqual(['table:uncited']);
  });

  it('counts the uncited blocks', () => {
    expect(uncitedCount(citeAnswer('One.\n\nTwo [[A]].\n\n- Three'))).toBe(2);
    expect(uncitedCount(citeAnswer(''))).toBe(0);
  });
});

describe('citeAnswer: code and headings in a quote (#845)', () => {
  it('exempts fenced code in a quote, as the editor draws it as code', () => {
    expect(verdicts('> ```\n> Mara Quill owns payroll\n> ```')).toEqual(['code:exempt']);
  });

  it('exempts a heading in a quote, and the heading’s link cites nothing under it', () => {
    // Read as one quote, the heading's link would count the claim under it as cited.
    expect(verdicts('> # [[Larkspur]]\n> Mara Quill owns payroll')).toEqual([
      'heading:exempt',
      'quote:uncited',
    ]);
  });
});

describe('citeAnswer: reading the blocks', () => {
  it('joins a paragraph’s lines, and starts a new one after a blank line', () => {
    const blocks = citeAnswer('First line\nsecond line [[A]]\n\nNext');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.citation).toBe('cited');
  });

  it('carries an item on through its indented lines, and a lazy one', () => {
    const blocks = citeAnswer('- An item\n  that goes on [[A]]\n- Another\nlazily [[B]]');
    expect(blocks.map((block) => block.citation)).toEqual(['cited', 'cited']);
  });

  it('keeps an indented paragraph after a blank line in its item, and ends the item at an outdented one', () => {
    expect(verdicts('- An item\n\n  still it [[A]]')).toEqual(['item:cited']);
    expect(verdicts('- An item\n\nNot it [[A]]')).toEqual(['item:uncited', 'paragraph:cited']);
  });

  it('nests items by indent, and comes back out', () => {
    const blocks = citeAnswer('- a\n  - b\n    - c\n- d');
    expect(blocks.map((block) => block.depth)).toEqual([0, 1, 2, 0]);
  });

  it('runs an unclosed fence to the end of the answer', () => {
    const blocks = citeAnswer('Text [[A]]\n\n```\ncode\n[[B]] more');
    expect(blocks.map((block) => `${block.kind}:${block.citation}`)).toEqual([
      'paragraph:cited',
      'code:exempt',
    ]);
    expect(blocks[1]?.inline).toEqual([{ kind: 'code', text: 'code\n[[B]] more' }]);
  });

  it('takes the marks off a heading, before and closing', () => {
    expect(citeAnswer('## Open loops ##')[0]?.inline).toEqual([
      { kind: 'text', text: 'Open loops' },
    ]);
  });

  it('closes a fence only on the same mark, at least as long', () => {
    const blocks = citeAnswer('````\n```\nstill code\n````\nAfter');
    expect(blocks.map((block) => block.kind)).toEqual(['code', 'paragraph']);
    expect(blocks[0]?.inline).toEqual([{ kind: 'code', text: '```\nstill code' }]);
  });

  it('closes a tilde fence', () => {
    expect(verdicts('~~~\ncode\n~~~\nText [[A]]')).toEqual(['code:exempt', 'paragraph:cited']);
  });

  it('lets a lazy line carry on a quote', () => {
    expect(verdicts('> Said\nby someone [[K]]')).toEqual(['quote:cited']);
  });

  it('starts a paragraph after a table', () => {
    expect(verdicts('| A |\nAfter [[K]]')).toEqual(['table:uncited', 'paragraph:cited']);
  });

  it('reads Windows line ends', () => {
    expect(verdicts('One [[A]]\r\n\r\nTwo')).toEqual(['paragraph:cited', 'paragraph:uncited']);
  });

  it('keeps an empty item', () => {
    expect(verdicts('-\n- b [[B]]')).toEqual(['item:uncited', 'item:cited']);
  });
});

describe('citeAnswer: the pieces of a block', () => {
  it('shows a citation by its alias, else by the note’s name, and keeps the link as written', () => {
    const [block] = citeAnswer('From [[Meetings/Kickoff#^t0003]] and [[Plan|the plan]].');
    expect(cites(block)).toEqual([
      { kind: 'cite', link: '[[Meetings/Kickoff#^t0003]]', label: 'Kickoff' },
      { kind: 'cite', link: '[[Plan|the plan]]', label: 'the plan' },
    ]);
  });

  it('leaves a link to a place in no note as its text: Ask is on no note to open (#547)', () => {
    const [block] = citeAnswer('See [[#^abc]] and [[]].');
    expect(block?.citation).toBe('uncited');
    expect(block?.inline).toEqual([{ kind: 'text', text: 'See [[#^abc]] and [[]].' }]);
  });

  it('takes what draws nothing out of a citation’s label, keeping the link as written', () => {
    const [block] = citeAnswer('From [[Kick\u200Boff#^t1]] and [[Plan|\u2066the plan\u2069]].');
    expect(cites(block)).toEqual([
      { kind: 'cite', link: '[[Kick\u200Boff#^t1]]', label: 'Kickoff' },
      { kind: 'cite', link: '[[Plan|\u2066the plan\u2069]]', label: 'the plan' },
    ]);
  });

  it('names a citation by its note when its alias is only invisible characters', () => {
    const [block] = citeAnswer('From [[Plan|\u200B]].');
    expect(cites(block)).toEqual([{ kind: 'cite', link: '[[Plan|\u200B]]', label: 'Plan' }]);
  });

  it('reads a markdown link to https as a web link, and anything else as the text it is', () => {
    const [block] = citeAnswer(
      '[spec](https://example.com/spec) [run](javascript:alert(1)) [old](http://example.com) [n](Plan.md)',
    );
    expect(block?.inline).toEqual([
      { kind: 'web', url: 'https://example.com/spec', label: 'spec', host: 'example.com' },
      { kind: 'text', text: ' [run](javascript:alert(1)) [old](http://example.com) [n](Plan.md)' },
    ]);
  });

  it('reads a bare https address, leaving the sentence’s full stop out of it', () => {
    const [block] = citeAnswer('Go to https://example.com/a?b=1. Then stop.');
    expect(block?.inline).toEqual([
      { kind: 'text', text: 'Go to ' },
      {
        kind: 'web',
        url: 'https://example.com/a?b=1',
        label: 'https://example.com/a?b=1',
        host: null,
      },
      { kind: 'text', text: '. Then stop.' },
    ]);
  });

  it('leaves html as text: nothing an answer says is markup', () => {
    const [block] = citeAnswer('<img src=x onerror=alert(1)> <b>bold</b>');
    expect(block?.inline).toEqual([
      { kind: 'text', text: '<img src=x onerror=alert(1)> <b>bold</b>' },
    ]);
  });

  it('takes the backticks and one padding space off a code span', () => {
    const [block] = citeAnswer('Run `` `x` `` and ` y `.');
    expect(block?.inline.filter((piece) => piece.kind === 'code')).toEqual([
      { kind: 'code', text: '`x`' },
      { kind: 'code', text: 'y' },
    ]);
  });

  it('keeps every character of a block across its pieces', () => {
    const text = 'A [[B]] `c` https://example.com/d [e](https://example.com/f) g';
    const [block] = citeAnswer(text);
    const written = (block?.inline ?? [])
      .map((piece) =>
        piece.kind === 'cite'
          ? piece.link
          : piece.kind === 'code'
            ? `\`${piece.text}\``
            : piece.kind === 'web'
              ? piece.label === piece.url
                ? piece.url
                : `[${piece.label}](${piece.url})`
              : piece.text,
      )
      .join('');
    expect(written).toBe(text);
  });
});

describe('web links, read by hand (#547)', () => {
  const webOf = (text: string) =>
    (citeAnswer(text)[0]?.inline ?? []).filter((piece) => piece.kind === 'web');

  it('keeps a pair of brackets in a bare address and in a markdown link', () => {
    const url = 'https://en.wikipedia.org/wiki/Foo_(bar)';
    expect(webOf(`See ${url}.`).map((piece) => piece.kind === 'web' && piece.url)).toEqual([url]);
    expect(webOf(`See [Foo](${url}).`).map((piece) => piece.kind === 'web' && piece.url)).toEqual([
      url,
    ]);
  });

  it('leaves a closing bracket the address did not open outside it', () => {
    const [block] = citeAnswer('(see https://example.com/a) [[A]]');
    expect(block?.inline[1]).toMatchObject({ kind: 'web', url: 'https://example.com/a' });
    expect(block?.inline[2]).toMatchObject({ kind: 'text', text: ') ' });
  });

  it('draws an autolink without its angle brackets', () => {
    const [block] = citeAnswer('Open <https://example.com/x> now.');
    expect(block?.inline).toEqual([
      { kind: 'text', text: 'Open ' },
      { kind: 'web', url: 'https://example.com/x', label: 'https://example.com/x', host: null },
      { kind: 'text', text: ' now.' },
    ]);
  });

  it('shows the host beside a label unless the label is the host or the address exactly', () => {
    expect(webOf('[the payroll portal](https://evil.example.com/p)')).toEqual([
      {
        kind: 'web',
        url: 'https://evil.example.com/p',
        label: 'the payroll portal',
        host: 'evil.example.com',
      },
    ]);
    // Only a label that is the host, or the address, exactly needs no host beside it.
    expect(webOf('[docs at example.com](https://example.com/d)')[0]).toMatchObject({
      host: 'example.com',
    });
    expect(webOf('[ Example.com ](https://example.com/d)')[0]).toMatchObject({ host: null });
    expect(webOf('[https://example.com/d](https://example.com/d)')[0]).toMatchObject({
      host: null,
    });
  });

  it('reads the address in a markdown link that is not one as a bare address, its own text shown', () => {
    const bare = {
      kind: 'web',
      url: 'https://example.com',
      label: 'https://example.com',
      host: null,
    };
    expect(webOf('[](https://example.com) and [x](https://example.com')).toEqual([bare, bare]);
  });
});

describe('isWebAddress', () => {
  it('opens only https with a host', () => {
    expect(isWebAddress('https://example.com')).toBe(true);
    expect(isWebAddress('http://example.com')).toBe(false);
    expect(isWebAddress('javascript:alert(1)')).toBe(false);
    expect(isWebAddress('https://')).toBe(false);
    expect(isWebAddress('file:///etc/passwd')).toBe(false);
  });

  it('opens only an address written as it parses, with no user part (#547)', () => {
    expect(isWebAddress('https://example.com/a?b=1#c')).toBe(true);
    expect(isWebAddress('https://user@example.com')).toBe(false);
    expect(isWebAddress('https://:pw@example.com')).toBe(false);
    expect(isWebAddress('https://EXAMPLE.com')).toBe(false);
    expect(isWebAddress('https://example.com/a b')).toBe(false);
    expect(isWebAddress('https:///example.com')).toBe(false);
  });
});

describe('citeAnswer: CommonMark’s edges (#547)', () => {
  const judgedOf = (answer: string) =>
    citeAnswer(answer).map((block) => `${block.kind}:${block.citation}`);

  it('makes a paragraph over a line of dashes a heading, and a lone line of dashes a rule', () => {
    expect(judgedOf('Open loops\n---\n\nOne [[A]]')).toEqual(['heading:exempt', 'paragraph:cited']);
    expect(citeAnswer('Open loops\n---')[0]?.inline).toEqual([
      { kind: 'text', text: 'Open loops' },
    ]);
    expect(judgedOf('---\n\nOne [[A]]')).toEqual(['rule:exempt', 'paragraph:cited']);
  });

  it('lets a bullet or a 1. with words interrupt a paragraph, and not an empty bullet', () => {
    expect(judgedOf('Steps [[A]]\n1. One [[B]]')).toEqual(['paragraph:cited', 'item:cited']);
    expect(judgedOf('Steps [[A]]\n- One [[B]]')).toEqual(['paragraph:cited', 'item:cited']);
    // `-` alone under a paragraph is a setext heading; an empty `*` interrupts nothing.
    expect(judgedOf('Steps [[A]]\n*')).toEqual(['paragraph:cited']);
  });

  it('opens a backtick fence with an info string, and a tilde fence whose info holds a backtick', () => {
    expect(judgedOf('```ts\nx\n```')).toEqual(['code:exempt']);
    expect(judgedOf('~~~ a`b\nx\n~~~')).toEqual(['code:exempt']);
  });

  it('marks the blocks of a quoted list as quoted, and keeps a quote without a list one block', () => {
    const blocks = citeAnswer('> Said by Mara:\n> - One [[A]]\n> - Two');
    expect(blocks.map((block) => [block.kind, block.quoted, block.citation])).toEqual([
      ['quote', true, 'exempt'],
      ['item', true, 'cited'],
      ['item', true, 'uncited'],
    ]);
    expect(citeAnswer('> One\n>\n> Two [[A]]').map((block) => block.quoted)).toEqual([false]);
  });

  it('judges a claim before a lead-in, and passes a lead-in with no claim before it', () => {
    expect(judgedOf('Moved to Friday. Steps:\n- One [[A]]')[0]).toBe('paragraph:uncited');
    expect(judgedOf('Moved to Friday (see "Plan.") Steps:\n- One [[A]]')[0]).toBe(
      'paragraph:uncited',
    );
    expect(judgedOf('The steps for v2.1 were:\n- One [[A]]')[0]).toBe('paragraph:exempt');
  });
});

describe('citeAnswer: fences inside items and quotes (verify #547)', () => {
  const judgedOf = (answer: string) =>
    citeAnswer(answer).map((block) => `${block.kind}:${block.citation}`);

  it('keeps a fence closed inside an item as the item’s code, and judges what the item says after it', () => {
    const blocks = citeAnswer(
      '- Run it [[A]]:\n  ```\n  npm test\n  ```\n  then it passes\n- Next [[B]]',
    );
    expect(blocks.map((block) => `${block.kind}:${block.citation}`)).toEqual([
      'item:cited',
      'code:exempt',
      'item:uncited',
      'item:cited',
    ]);
    expect(blocks[1]?.inline).toEqual([{ kind: 'code', text: 'npm test' }]);
  });

  it('draws nothing more for an item whose fence closed with nothing after it', () => {
    expect(judgedOf('- Run it [[A]]:\n  ```\n  npm test\n  ```\n- Next [[B]]')).toEqual([
      'item:cited',
      'code:exempt',
      'item:cited',
    ]);
  });

  it('lets no lazy line carry on a quote that ended on a blank line', () => {
    expect(judgedOf('> Said [[A]]\n>\nNot quoted')).toEqual(['quote:cited', 'paragraph:uncited']);
  });
});
