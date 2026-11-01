import { describe, expect, it } from 'vitest';
import {
  createVaultPath,
  pageThumbnailPath,
  pageThumbnailSrc,
  parseObjectType,
} from '@dfai/domain';
import type { ThumbnailSnapshot } from '@dfai/application';
import { pageThumbnailState } from './page-thumbnail-view.ts';

const DUNE = createVaultPath('Books/Dune.md');
const BOOK = parseObjectType({ name: 'book', properties: { art: 'thumbnail' } });
const IDLE: ThumbnailSnapshot = { state: () => null, made: () => 0, madeInAll: () => 0 };
const PLAIN = parseObjectType({ name: 'task', properties: { status: 'select' } });
const PICTURED = new Map([[pageThumbnailPath(DUNE), 1]]);

function stateOf({
  properties,
  type = BOOK,
  queue = IDLE,
  pictured = PICTURED,
  chooseError = null,
}: {
  properties: Record<string, unknown>;
  type?: typeof BOOK;
  queue?: ThumbnailSnapshot;
  pictured?: ReadonlyMap<string, number> | null;
  chooseError?: string | null;
}) {
  return pageThumbnailState({
    note: { path: DUNE, properties },
    type,
    queue,
    pictured,
    chooseError,
  });
}

describe('pageThumbnailState', () => {
  it('is nothing for no note, a note with no thumbnail, or an artifact', () => {
    expect(
      pageThumbnailState({
        note: null,
        type: BOOK,
        queue: IDLE,
        pictured: null,
        chooseError: null,
      }),
    ).toBeNull();
    expect(stateOf({ properties: { type: 'task' }, type: PLAIN })).toBeNull();
    expect(stateOf({ properties: { type: 'artifact', thumbnail: 'auto' } })).toBeNull();
  });

  it('on auto, shows the picture of the page once there is one', () => {
    expect(stateOf({ properties: { art: 'auto' } })).toEqual({
      key: 'art',
      shown: pageThumbnailSrc(DUNE),
      cleared: false,
      generating: false,
      failure: null,
      discards: null,
    });
    expect(stateOf({ properties: {}, pictured: new Map() })?.shown).toBeNull();
    expect(stateOf({ properties: {}, pictured: null })?.shown).toBeNull();
  });

  it('shows a picture chosen, and says what Regenerate would discard of it', () => {
    expect(stateOf({ properties: { art: '/Books/me.png' } })).toMatchObject({
      shown: '/Books/me.png',
      discards: null,
    });
    const url = 'https://example.com/dune.jpg';
    expect(stateOf({ properties: { art: url } })).toMatchObject({ shown: url, discards: url });
  });

  it('shows nothing for one cleared, and says it was', () => {
    expect(stateOf({ properties: { art: false } })).toMatchObject({ shown: null, cleared: true });
  });

  it('is a note’s own thumbnail when its type has none', () => {
    expect(stateOf({ properties: { thumbnail: null }, type: PLAIN })?.key).toBe('thumbnail');
  });

  it('says it is being made, or why making it or keeping a chosen one failed', () => {
    const generating: ThumbnailSnapshot = { ...IDLE, state: () => ({ kind: 'generating' }) };
    expect(stateOf({ properties: {}, queue: generating })?.generating).toBe(true);
    const failed: ThumbnailSnapshot = {
      ...IDLE,
      state: () => ({ kind: 'failed', reason: 'the host could not picture it' }),
    };
    expect(stateOf({ properties: {}, queue: failed })?.failure).toBe(
      'the host could not picture it',
    );
    expect(stateOf({ properties: {}, queue: failed, chooseError: 'too big' })?.failure).toBe(
      'too big',
    );
  });
});
