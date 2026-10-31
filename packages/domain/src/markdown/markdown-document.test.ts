import { describe, expect, it } from 'vitest';
import {
  appendToBody,
  isBlankFrontmatter,
  joinDocument,
  joinFrontmatter,
  opensUnclosedFrontmatter,
  splitFrontmatter,
  withBody,
} from './markdown-document.ts';

describe('opensUnclosedFrontmatter (#683)', () => {
  it('is a file that opens a block on its first line and never closes it', () => {
    expect(opensUnclosedFrontmatter('---\nname: recipe\nlabel: Recipe\n\n# Recipe\n')).toBe(true);
    expect(opensUnclosedFrontmatter('﻿---\r\nname: recipe\r\n')).toBe(true);
  });

  it('is not a file whose block closes, or that opens no block', () => {
    expect(opensUnclosedFrontmatter('---\nname: recipe\n---\n')).toBe(false);
    expect(opensUnclosedFrontmatter('# Recipe\n\n---\n')).toBe(false);
    expect(opensUnclosedFrontmatter('')).toBe(false);
  });
});

describe('appendToBody', () => {
  it('adds the markdown after one blank line', () => {
    expect(appendToBody('# Log\n\nFirst.\n', 'Second.')).toBe('# Log\n\nFirst.\n\nSecond.\n');
  });

  it('collapses trailing blank lines rather than stacking more', () => {
    expect(appendToBody('First.\n\n\n  \n', 'Second.\n')).toBe('First.\n\nSecond.\n');
  });

  it('starts an empty body with the markdown alone', () => {
    expect(appendToBody('\n\n', '- [ ] call Sam')).toBe('- [ ] call Sam\n');
  });

  it('keeps the last line byte for byte, trailing hard break included', () => {
    expect(appendToBody('* one\n* two  \n', 'x')).toBe('* one\n* two  \n\nx\n');
  });
});

describe('splitFrontmatter', () => {
  it('separates frontmatter from body', () => {
    const document = splitFrontmatter('---\ntitle: Today\n---\n# Today\n');
    expect(document.frontmatter).toBe('---\ntitle: Today\n---\n');
    expect(document.body).toBe('# Today\n');
  });

  it('reports where the body starts', () => {
    const document = splitFrontmatter('---\na: 1\n---\nbody');
    expect(document.bodyOffset).toBe('---\na: 1\n---\n'.length);
  });

  it('handles an empty frontmatter block', () => {
    const document = splitFrontmatter('---\n---\nbody\n');
    expect(document.frontmatter).toBe('---\n---\n');
    expect(document.body).toBe('body\n');
  });

  it('handles frontmatter with no body after it', () => {
    const document = splitFrontmatter('---\na: 1\n---\n');
    expect(document.frontmatter).toBe('---\na: 1\n---\n');
    expect(document.body).toBe('');
  });

  it('handles a closing delimiter with no trailing newline', () => {
    const document = splitFrontmatter('---\na: 1\n---');
    expect(document.frontmatter).toBe('---\na: 1\n---');
    expect(document.body).toBe('');
  });

  it('keeps CRLF line endings exactly as they are', () => {
    const text = '---\r\ntitle: Today\r\n---\r\n# Today\r\n';
    const document = splitFrontmatter(text);
    expect(document.frontmatter).toBe('---\r\ntitle: Today\r\n---\r\n');
    expect(document.body).toBe('# Today\r\n');
  });

  it('tolerates trailing spaces on the delimiter lines', () => {
    const document = splitFrontmatter('--- \na: 1\n---  \nbody');
    expect(document.body).toBe('body');
  });

  it('keeps nested --- inside the frontmatter block', () => {
    const document = splitFrontmatter('---\nnote: "a --- b"\n---\nbody');
    expect(document.frontmatter).toBe('---\nnote: "a --- b"\n---\n');
  });

  it('stops at the first closing delimiter', () => {
    const document = splitFrontmatter('---\na: 1\n---\nbody\n---\nmore\n');
    expect(document.frontmatter).toBe('---\na: 1\n---\n');
    expect(document.body).toBe('body\n---\nmore\n');
  });

  describe('is not fooled by a horizontal rule', () => {
    it('treats an unterminated block as body', () => {
      const text = '---\nthis never closes\n';
      expect(splitFrontmatter(text)).toEqual({ frontmatter: null, body: text, bodyOffset: 0 });
    });

    it('ignores a --- that is not on the first line', () => {
      const text = '\n---\na: 1\n---\n';
      expect(splitFrontmatter(text).frontmatter).toBeNull();
    });

    it('ignores a --- preceded by text', () => {
      const text = '# Title\n\n---\n\nmore\n';
      expect(splitFrontmatter(text).frontmatter).toBeNull();
    });

    it('does not treat a longer rule as a delimiter', () => {
      expect(splitFrontmatter('----\na: 1\n----\n').frontmatter).toBeNull();
    });
  });

  it('handles an empty file', () => {
    expect(splitFrontmatter('')).toEqual({ frontmatter: null, body: '', bodyOffset: 0 });
  });
});

describe('the split is lossless', () => {
  const corpus = [
    '',
    'just text',
    '# Heading\n\nA paragraph.\n',
    '---\na: 1\n---\n',
    '---\na: 1\n---\nbody\n',
    '---\r\na: 1\r\n---\r\nbody\r\n',
    '---\n---\n',
    '---\nunterminated\n',
    '---\na: "x---y"\n---\n\n- one\n- two\n',
    'text with trailing newlines\n\n\n',
    '﻿---\na: 1\n---\n',
    '---\na: 1\n---',
  ];

  it.each(corpus)('rejoins to the original: %j', (text) => {
    expect(joinDocument(splitFrontmatter(text))).toBe(text);
  });
});

describe('withBody', () => {
  it('replaces the body and leaves the frontmatter untouched', () => {
    const document = splitFrontmatter('---\na: 1\n---\nold\n');
    const updated = withBody(document, 'new\n');
    expect(joinDocument(updated)).toBe('---\na: 1\n---\nnew\n');
  });
});

describe('joinFrontmatter', () => {
  it('starts the body on its own line when the frontmatter closes on the last byte', () => {
    const text = joinFrontmatter('---\nstatus: todo\n---', 'Body.\n');
    expect(text).toBe('---\nstatus: todo\n---\nBody.\n');
    expect(splitFrontmatter(text)).toMatchObject({
      frontmatter: '---\nstatus: todo\n---\n',
      body: 'Body.\n',
    });
  });

  it('keeps every byte when the frontmatter already ends its line', () => {
    expect(joinFrontmatter('---\na: 1\n---\n', '\n# Title\n')).toBe('---\na: 1\n---\n\n# Title\n');
    expect(joinFrontmatter('---\na: 1\n---\r\n', 'x')).toBe('---\na: 1\n---\r\nx');
  });

  it('adds nothing to frontmatter at the end of file when there is no body', () => {
    expect(joinFrontmatter('---\na: 1\n---', '')).toBe('---\na: 1\n---');
  });

  it('keeps a body that would read as frontmatter from becoming frontmatter', () => {
    const text = joinFrontmatter(null, '---\ntype: Invoice\n---\n');
    expect(text).toBe('\n---\ntype: Invoice\n---\n');
    expect(splitFrontmatter(text).frontmatter).toBeNull();
  });

  it('leaves a body alone when it opens with a rule that never closes into frontmatter', () => {
    expect(joinFrontmatter(null, '---\nno closing fence\n')).toBe('---\nno closing fence\n');
    expect(joinFrontmatter(null, 'plain\n')).toBe('plain\n');
  });
});

describe('a file that starts with a byte-order mark (A20-05)', () => {
  it('still has its frontmatter, the mark kept with it so the split stays lossless', () => {
    const text = '\uFEFF---\ntitle: Plan\n---\nBody.\n';
    const document = splitFrontmatter(text);
    expect(document.frontmatter).toBe('\uFEFF---\ntitle: Plan\n---\n');
    expect(document.body).toBe('Body.\n');
    expect(joinDocument(document)).toBe(text);
  });

  it('is only a mark when no block follows it', () => {
    expect(splitFrontmatter('\uFEFFBody.\n')).toEqual({
      frontmatter: null,
      body: '\uFEFFBody.\n',
      bodyOffset: 0,
    });
  });
});

describe('isBlankFrontmatter (A20-05)', () => {
  it.each(['---\n---\n', '---\r\n---\r\n', '---\n\n---\n', '\uFEFF---\n---\n', '---\n---'])(
    'is blank: %j',
    (block) => expect(isBlankFrontmatter(block)).toBe(true),
  );

  it.each(['---\n# a comment\n---\n', '---\n{}\n---\n', '---\na: 1\n---\n'])(
    'is not blank: %j',
    (block) => expect(isBlankFrontmatter(block)).toBe(false),
  );
});
