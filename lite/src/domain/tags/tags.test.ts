import { buildTagTree, findTags, noteTags, tagKey } from './index.ts';

const names = (text: string) => findTags(text).map((tag) => tag.name);

describe('finding tags', () => {
  it('finds inline and nested tags', () => {
    expect(names('A note #meeting about #area/health.')).toEqual(['meeting', 'area/health']);
  });

  it('is not fooled by a heading, a number, or a # inside a word', () => {
    expect(names('# Heading\n#123 C# issue#12 #2026')).toEqual([]);
  });

  it('skips code, links, URLs and comments', () => {
    const text = [
      '`#code` ```',
      '```',
      '#fenced',
      '```',
      '[[Note#Heading]] [text](https://example.com/#anchor) www.example.com/#x',
      '<!-- #hidden --> #real',
    ].join('\n');
    expect(names(text)).toEqual(['real']);
  });

  it('ends a tag at punctuation and leaves a closing underscore out', () => {
    expect(names('(#idea), #my_tag_ #a/b/')).toEqual(['idea', 'my_tag', 'a/b']);
  });

  it('lists a note’s tags once each, as first written', () => {
    expect(noteTags('#Idea #idea #other')).toEqual([
      { key: 'idea', name: 'Idea' },
      { key: 'other', name: 'other' },
    ]);
    expect(tagKey('Idéa')).toBe(tagKey('Idéa'));
  });
});

describe('the tag tree', () => {
  it('nests under each part and totals the uses below', () => {
    const [area] = buildTagTree(
      [
        { key: 'area/health', name: 'area/health', count: 2 },
        { key: 'area/home', name: 'area/home', count: 1 },
      ],
      'name',
    );
    expect(area).toMatchObject({ key: 'area', label: 'area', count: 0, total: 3 });
    expect(area?.children.map((child) => child.label)).toEqual(['health', 'home']);
  });
});
