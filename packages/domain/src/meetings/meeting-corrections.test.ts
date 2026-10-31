import { describe, expect, it } from 'vitest';
import { correctionDigestOf } from './correction-digest.ts';
import { vocabulary } from '../terms/vocabulary.ts';
import { countedWork } from '../testing/counted-work.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import {
  correctionProperties,
  correctMeetingBody,
  CORRECTIONS_DIGEST_KEY,
  CORRECTIONS_KEY,
  CORRECTIONS_ORIGINAL_DIGEST_KEY,
  NOTHING_CORRECTED_PROPERTIES,
  recordedCorrections,
  UNDONE_CORRECTION_PROPERTIES,
  undoMeetingCorrections,
  wasCorrected,
} from './meeting-corrections.ts';
import {
  placeSummary,
  readSummaryBlock,
  removeSummary,
  renderSummaryBlock,
} from './meeting-summary-block.ts';

const VOCABULARY = vocabulary({
  terms: [
    {
      path: createVaultPath('Terms/Larkspur Pay.md'),
      canonical: 'Larkspur Pay',
      variants: ['Lark Spur Pay'],
      kind: 'product',
    },
    {
      path: createVaultPath('Terms/Mara Quill.md'),
      canonical: 'Mara Quill',
      variants: ['Mara Quil'],
      kind: 'person',
    },
  ],
  people: [
    { path: createVaultPath('People/Mara Quill.md'), name: 'Mara Quill', aliases: ['Mara Quil'] },
  ],
  companies: [],
});

const BODY = [
  '# Lark Spur Pay weekly',
  '',
  '## Summary',
  '',
  'Mara Quil says Lark Spur Pay ships Friday. ^s1',
  '',
  '## Notes',
  '',
  '- Lark Spur Pay cache',
  '',
  '## Provider next steps',
  '',
  '- [Mara Quil] Draft the Lark Spur Pay note. ^n1',
  '',
  '## Transcript',
  '',
  '**Mara Quil** [~00:00:00] Lark Spur Pay is ready. ^t0001',
  '',
  '**Tobias Fenn** [~00:00:05] And [[Lark Spur Pay]] too. ^t0002',
  '',
].join('\r\n');

describe('correctMeetingBody', () => {
  it('corrects the four sections and nothing before them, recording each change and its blocks', () => {
    const correction = correctMeetingBody(BODY, VOCABULARY);

    expect(correction.body).toBe(
      BODY.replace(/Mara Quil\b/g, 'Mara Quill').replace(
        /(?<!\[\[|# )Lark Spur Pay/g,
        'Larkspur Pay',
      ),
    );
    expect(correction.body.startsWith('# Lark Spur Pay weekly')).toBe(true);
    expect(correction.body).toContain('[[Lark Spur Pay]]');
    expect(correction.count).toBe(7);
    expect(
      correction.records.map(({ from, to, count, blocks }) => ({ from, to, count, blocks })),
    ).toEqual([
      { from: 'Mara Quil', to: 'Mara Quill', count: 3, blocks: ['s1', 'n1', 't0001'] },
      { from: 'Lark Spur Pay', to: 'Larkspur Pay', count: 4, blocks: ['s1', 'n1', 't0001'] },
    ]);
  });

  it('records where each corrected spelling stands in the corrected body', () => {
    const correction = correctMeetingBody(BODY, VOCABULARY);
    for (const record of correction.records) {
      for (const at of record.at) {
        expect(correction.body.slice(at, at + record.to.length)).toBe(record.to);
      }
    }
  });

  it('changes nothing in a meeting with no misheard spelling', () => {
    const body = '## Summary\n\nLarkspur Pay ships. ^s1\n';
    expect(correctMeetingBody(body, VOCABULARY)).toMatchObject({ body, records: [], count: 0 });
  });

  it('writes the change list and the digest of the corrected body as frontmatter', () => {
    const correction = correctMeetingBody(BODY, VOCABULARY);
    const properties = correctionProperties(correction);

    expect(properties[CORRECTIONS_DIGEST_KEY]).toBe(correctionDigestOf(correction.body));
    expect(properties[CORRECTIONS_ORIGINAL_DIGEST_KEY]).toBe(correctionDigestOf(BODY));
    expect(recordedCorrections(properties)).toEqual(correction.records);
    expect(wasCorrected(properties)).toBe(true);
    expect(wasCorrected({ type: 'meeting' })).toBe(false);
  });
});

describe('correctMeetingBody, at scale', () => {
  // 0.6 s on a Mac, up to 3.2 s on a loaded 4-core CI runner (#648): the default 5 s is too close.
  it('finds the block of each change in a section of many blocks with work that is not quadratic', () => {
    const sectionOf = (blocks: number) => {
      const paragraphs = Array.from({ length: blocks }, (_, at) => `Lark Spur Pay item. ^p${at}`);
      return ['## Summary', '', ...paragraphs.flatMap((each) => [each, ''])].join('\n');
    };
    const correcting = (body: string) => () => correctMeetingBody(body, VOCABULARY);

    const correction = correcting(sectionOf(20000))();
    expect(correction.count).toBe(20000);
    expect(correction.records[0]?.blocks.slice(0, 2)).toEqual(['p0', 'p1']);
    // Four times the blocks, each with a change: four times the work, where a
    // scan of the section per change is sixteen. The quadratic one took over a minute.
    const small = countedWork(correcting(sectionOf(5000)));
    const large = countedWork(correcting(sectionOf(20000)));
    expect(large).toBeLessThan(small * 8);
  }, 15_000);
});

describe('a meeting read with nothing to correct', () => {
  it('is marked, so it is never read again, and has nothing to undo', () => {
    expect(wasCorrected(NOTHING_CORRECTED_PROPERTIES)).toBe(true);
    expect(recordedCorrections(NOTHING_CORRECTED_PROPERTIES)).toBeNull();
    expect(
      undoMeetingCorrections({ body: BODY, properties: NOTHING_CORRECTED_PROPERTIES }).ok,
    ).toBe(false);
  });
});

describe('the digest of a correction', () => {
  it('tells apart two bodies one character or one transposition apart, and is the same every time', () => {
    const digests = ['abc', 'abd', 'acb', 'abc ', 'ABC', ''].map(correctionDigestOf);
    expect(new Set(digests).size).toBe(digests.length);
    expect(correctionDigestOf('abc')).toBe(correctionDigestOf('abc'));
    expect(correctionDigestOf('abc')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{14}-3$/);
  });
});

describe('undoMeetingCorrections', () => {
  const correction = correctMeetingBody(BODY, VOCABULARY);
  const properties = correctionProperties(correction);

  it('gives back exactly the original bytes', () => {
    expect(undoMeetingCorrections({ body: correction.body, properties })).toEqual({
      ok: true,
      body: BODY,
    });
  });

  it('is refused when the body changed since it was corrected', () => {
    const edited = correction.body.replace('ships Friday', 'ships Monday');
    expect(undoMeetingCorrections({ body: edited, properties })).toEqual({
      ok: false,
      reason: 'The meeting changed since its words were corrected, so they were left as they are.',
    });
  });

  it('is refused when the record has no digest of the original, as one from an earlier build has not', () => {
    const legacy = { ...properties, [CORRECTIONS_ORIGINAL_DIGEST_KEY]: undefined };
    expect(undoMeetingCorrections({ body: correction.body, properties: legacy })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/do not match its words/),
    });
  });

  it('is refused when the original digest is not the body it rebuilds', () => {
    const edited = { ...properties, [CORRECTIONS_ORIGINAL_DIGEST_KEY]: correctionDigestOf('x') };
    expect(undoMeetingCorrections({ body: correction.body, properties: edited }).ok).toBe(false);
  });

  it('is refused when there is nothing recorded to undo, or it was undone', () => {
    const refusal = { ok: false, reason: 'This meeting has no corrections to undo.' };
    expect(undoMeetingCorrections({ body: BODY, properties: {} })).toEqual(refusal);
    expect(
      undoMeetingCorrections({ body: BODY, properties: { ...UNDONE_CORRECTION_PROPERTIES } }),
    ).toEqual(refusal);
  });

  it('believes no record that does not match the body, or that the correction could not have written', () => {
    const records = recordedCorrections(properties) ?? [];
    const first = records[0];
    if (first === undefined) throw new Error('expected a record');
    const misplaced = {
      ...properties,
      [CORRECTIONS_KEY]: [{ ...first, at: first.at.map((at) => at + 1) }],
    };
    expect(undoMeetingCorrections({ body: correction.body, properties: misplaced })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/do not match its words/),
    });
    const overlapping = { ...properties, [CORRECTIONS_KEY]: [first, first] };
    expect(undoMeetingCorrections({ body: correction.body, properties: overlapping }).ok).toBe(
      false,
    );
    for (const broken of [
      'Mara Quil',
      [{ ...first, count: first.count + 1 }],
      [{ ...first, at: [-1], count: 1 }],
      [{ ...first, from: '' }],
      [{ ...first, blocks: [3] }],
      [null],
      [],
    ]) {
      expect(recordedCorrections({ [CORRECTIONS_KEY]: broken }), JSON.stringify(broken)).toBeNull();
    }
  });
});

describe('corrections and the summary Claude writes at the top (#185)', () => {
  const SUMMARY_BLOCK = renderSummaryBlock({
    model: 'claude-sonnet-5-5',
    date: '2026-10-14',
    // Words the vocabulary would correct, were the block corrected: it never is.
    summary: 'Mara Quil says Lark Spur Pay ships Friday.',
    keyPoints: ['Lark Spur Pay is ready'],
    decisions: [],
    actionItems: [],
    openQuestions: [],
  }).text;
  const summarised = (body: string): string => {
    const placed = placeSummary(body, SUMMARY_BLOCK, { recorded: null });
    if (!placed.ok) throw new Error(placed.reason);
    return placed.body;
  };
  const blockText = (body: string): string => {
    const reading = readSummaryBlock(body);
    if (reading.kind !== 'block') throw new Error(`no block: ${reading.kind}`);
    return reading.text;
  };

  it('Undo corrections still gives back the original once a summary is written above them', () => {
    // Corrected at import, as every correction recorded before the summary existed was.
    const correction = correctMeetingBody(BODY, VOCABULARY);
    const properties = correctionProperties(correction);

    const undone = undoMeetingCorrections({ body: summarised(correction.body), properties });

    expect(undone).toEqual({ ok: true, body: summarised(BODY) });
  });

  it('corrects a meeting with a summary as it would one without, the block left as written', () => {
    const plain = correctMeetingBody(BODY, VOCABULARY);

    const correction = correctMeetingBody(summarised(BODY), VOCABULARY);

    expect(correction.body).toBe(summarised(plain.body));
    expect(correctionProperties(correction)).toEqual(correctionProperties(plain));
    const properties = correctionProperties(correction);
    expect(undoMeetingCorrections({ body: correction.body, properties })).toEqual({
      ok: true,
      body: summarised(BODY),
    });
    // Its summary undone too, the corrections still come off.
    const digest = readSummaryBlock(correction.body);
    if (digest.kind !== 'block') throw new Error('no block');
    const taken = removeSummary(correction.body, { recorded: digest.digest });
    if (!taken.ok) throw new Error(taken.reason);
    expect(undoMeetingCorrections({ body: taken.body, properties })).toEqual({
      ok: true,
      body: BODY,
    });
  });

  it('never corrects the words of a summary block pasted into a section, and undoes around it', () => {
    const block = summarised('').trim().replace(/\n/g, '\r\n');
    const pasted = BODY.replace('- Lark Spur Pay cache', `- Lark Spur Pay cache\r\n\r\n${block}`);
    expect(blockText(pasted)).toContain('Lark Spur Pay ships');

    const correction = correctMeetingBody(pasted, VOCABULARY);

    expect(blockText(correction.body)).toBe(blockText(pasted));
    expect(correction.body).toContain('- Larkspur Pay cache');
    expect(
      undoMeetingCorrections({
        body: correction.body,
        properties: correctionProperties(correction),
      }),
    ).toEqual({ ok: true, body: pasted });
  });
});
