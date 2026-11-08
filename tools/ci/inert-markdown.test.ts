import { describe, expect, it } from 'vitest';
import { fenced, inert } from './inert-markdown.ts';

describe('text made inert for an issue', () => {
  it('mentions no one and links no issue', () => {
    const text = inert('pings @octocat and closes #12, see acme/notes#3');
    expect(text).not.toMatch(/@octocat|#12|#3/);
    expect(text.replace(/\u200b/g, '')).toBe('pings @octocat and closes #12, see acme/notes#3');
  });

  it('escapes the characters Markdown acts on, a backtick among them', () => {
    expect(inert('x` *bold* [link](u) <b> a|b')).toBe(
      'x\\` \\*bold\\* \\[link\\](u) \\<b\\> a\\|b',
    );
  });

  it('keeps a heading-like # that no digit follows, and folds newlines', () => {
    expect(inert('# not a ref\nnext')).toBe('# not a ref next');
  });
});

describe('a fenced error', () => {
  it('is fenced with four backticks for plain lines', () => {
    expect(fenced(['Timed out'])).toBe('````text\nTimed out\n````');
  });

  it('takes a fence longer than any backtick run in the error, so the error cannot close it', () => {
    const block = fenced(['before', '`````', 'after ```` x']);
    expect(block.startsWith('``````text\n')).toBe(true);
    expect(block.endsWith('\n``````')).toBe(true);
  });

  it('says so when the error had no message', () => {
    expect(fenced([])).toBe('````text\n(no error message)\n````');
  });
});
