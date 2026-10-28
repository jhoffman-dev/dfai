import { describe, expect, it } from 'vitest';
import { withRelatedLink } from './related-section.ts';

describe('withRelatedLink', () => {
  it('starts a Related section at the end, after a blank line, keeping every byte before it', () => {
    const body = 'Mara Quill moves payday to Friday.\n';
    const written = withRelatedLink(body, 'Garden');
    expect(written).toBe(`${body}\n## Related\n\n- [[Garden]]\n`);
    expect(written!.startsWith(body)).toBe(true);
  });

  it('adds the line break a body without one lacks', () => {
    expect(withRelatedLink('Notes', 'Garden')).toBe('Notes\n\n## Related\n\n- [[Garden]]\n');
  });

  it('adds no second blank line after one already there', () => {
    expect(withRelatedLink('Notes\n\n', 'Garden')).toBe('Notes\n\n## Related\n\n- [[Garden]]\n');
  });

  it('writes the section alone into an empty body', () => {
    expect(withRelatedLink('', 'Garden')).toBe('## Related\n\n- [[Garden]]\n');
  });

  it('adds to the list under an existing Related heading, before what follows it', () => {
    const body = '# Plan\n\n## Related\n\n- [[Budget]]\n\n## Later\n\nMore.\n';
    expect(withRelatedLink(body, 'Garden')).toBe(
      '# Plan\n\n## Related\n\n- [[Budget]]\n- [[Garden]]\n\n## Later\n\nMore.\n',
    );
  });

  it('keeps a level-three heading inside the section, adding after its last line', () => {
    const body = '## Related\n\n- [[Budget]]\n\n### Older\n\n- [[Bees]]';
    expect(withRelatedLink(body, 'Garden')).toBe(
      '## Related\n\n- [[Budget]]\n\n### Older\n\n- [[Bees]]\n- [[Garden]]\n',
    );
  });

  it('starts the list under an empty Related heading', () => {
    expect(withRelatedLink('Notes\n\n## Related\n', 'Garden')).toBe(
      'Notes\n\n## Related\n\n- [[Garden]]\n',
    );
    expect(withRelatedLink('## Related', 'Garden')).toBe('## Related\n\n- [[Garden]]\n');
  });

  it('leaves a blank line after prose in the section, so the link is its own list', () => {
    expect(withRelatedLink('## Related\n\nSee also:\n', 'Garden')).toBe(
      '## Related\n\nSee also:\n\n- [[Garden]]\n',
    );
  });

  it('reads the heading in any case and with closing hashes', () => {
    expect(withRelatedLink('## RELATED ##\n- [[Budget]]\n', 'Garden')).toBe(
      '## RELATED ##\n- [[Budget]]\n- [[Garden]]\n',
    );
  });

  it('does not take a "## Related" inside a fenced code block for the heading', () => {
    const body = '```md\n## Related\n```\n';
    expect(withRelatedLink(body, 'Garden')).toBe(`${body}\n## Related\n\n- [[Garden]]\n`);
    const tildes = '~~~\n## Related\n```\n~~~\n';
    expect(withRelatedLink(tildes, 'Garden')).toBe(`${tildes}\n## Related\n\n- [[Garden]]\n`);
  });

  it('does not take "## Related reading" for the heading', () => {
    const body = '## Related reading\n\n- [[Book]]\n';
    expect(withRelatedLink(body, 'Garden')).toBe(`${body}\n## Related\n\n- [[Garden]]\n`);
  });

  it('adds to the last Related section when there are two', () => {
    const body = '## Related\n- [[A]]\n\n# Next\n\n## Related\n- [[B]]\n';
    expect(withRelatedLink(body, 'Garden')).toBe(
      '## Related\n- [[A]]\n\n# Next\n\n## Related\n- [[B]]\n- [[Garden]]\n',
    );
  });

  it('writes nothing when the section already links the note, however the link is spelled', () => {
    expect(withRelatedLink('## Related\n\n- [[Garden]]\n', 'Garden')).toBeNull();
    expect(withRelatedLink('## Related\n\n- [[garden|the garden]]\n', 'Garden')).toBeNull();
    expect(withRelatedLink('## Related\n\n- [[Garden#Bees]]\n', 'Garden')).toBeNull();
  });

  it('adds with CRLF to a body written with CRLF', () => {
    expect(withRelatedLink('Notes\r\n', 'Garden')).toBe(
      'Notes\r\n\r\n## Related\r\n\r\n- [[Garden]]\r\n',
    );
    expect(withRelatedLink('## Related\r\n\r\n- [[A]]\r\n', 'Garden')).toBe(
      '## Related\r\n\r\n- [[A]]\r\n- [[Garden]]\r\n',
    );
  });
});
