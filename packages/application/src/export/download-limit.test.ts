import { describe, expect, it } from 'vitest';
import { MAX_DOWNLOAD_EXPORT_BYTES, refuseOversizedDownload } from './download-limit.ts';
import { ExportError } from './ports.ts';

describe('the most a download export may hold (#779)', () => {
  it('is 200 MB: what an iPad keeps in memory and zips without trouble', () => {
    expect(MAX_DOWNLOAD_EXPORT_BYTES).toBe(200 * 1024 * 1024);
  });

  it('lets an export of up to the limit through', () => {
    expect(() => refuseOversizedDownload(MAX_DOWNLOAD_EXPORT_BYTES)).not.toThrow();
    expect(() => refuseOversizedDownload(5, 5)).not.toThrow();
  });

  it('refuses one byte more, as too large, saying why and what to do', () => {
    let refused: unknown;
    try {
      refuseOversizedDownload(MAX_DOWNLOAD_EXPORT_BYTES + 1);
    } catch (cause) {
      refused = cause;
    }
    expect(refused).toBeInstanceOf(ExportError);
    expect(refused).toMatchObject({ kind: 'too-large' });
    expect((refused as Error).message).toBe(
      'This export is too large to download here: its notes and pictures come to more than 200 MB. Export fewer notes at once, or export on the Mac.',
    );
  });

  it('refuses past a smaller limit it is given, naming that limit', () => {
    expect(() => refuseOversizedDownload(6, 5)).toThrow('more than 5 bytes');
  });
});
