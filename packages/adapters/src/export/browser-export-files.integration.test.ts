/**
 * #774: notes exported on the web, through the export use-case the desktop
 * runs, the real Markdown reader and the real zip library, then read back
 * from the download the way the person's Files app would unpack it.
 */
import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { createVaultPath, type VaultPath } from '@dfai/domain';
import { fakeIndexPort, readOnlyVault, saveExport, type FileFormat } from '@dfai/application';
import { remarkMarkdown } from '../markdown/markdown-port.ts';
import { browserExportFiles } from './browser-export-files.ts';
import type { DownloadFile } from './browser-download.ts';
import { loadZipFiles } from './zip-files.ts';

const PICTURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);

const NOT_USED = (): never => {
  throw new Error('Markdown is not drawn');
};

function setUp(vault: Record<string, string | Uint8Array>) {
  const downloads: DownloadFile[] = [];
  const notePaths = Object.keys(vault)
    .filter((path) => path.endsWith('.md'))
    .map(createVaultPath);
  const ports = {
    fs: readOnlyVault(vault),
    markdown: remarkMarkdown,
    index: fakeIndexPort(),
    files: browserExportFiles({
      download: (file) => {
        downloads.push(file);
        return Promise.resolve();
      },
      loadZip: loadZipFiles,
    }),
    pdf: { pagingScript: '', render: NOT_USED },
    renderer: { bodyHtml: NOT_USED, styles: '' },
    clock: { today: () => '2026-11-05', now: () => 0, localNow: () => '2026-11-05T09:00:00' },
  };
  const run = (format: FileFormat, paths: string[]) =>
    saveExport(ports, { format, paths: paths as VaultPath[], notePaths, keepFrontmatter: false });
  return { run, downloads };
}

const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);

/** The one download, unpacked: each file's path and its bytes. */
function unpacked(downloads: readonly DownloadFile[]): Record<string, Uint8Array> {
  expect(downloads).toHaveLength(1);
  return unzipSync(downloads[0]!.bytes);
}

describe('exporting on the web (#774)', () => {
  it('downloads a note with no pictures, as it is, byte for byte', async () => {
    const note = '---\nstatus: draft\n---\n# Kickoff\n\nAgenda for Larkspur Payroll.\n';
    const { run, downloads } = setUp({ 'Projects/Kickoff.md': note });
    const outcome = await run('markdown', ['Projects/Kickoff.md']);
    expect(outcome).toMatchObject({ kind: 'saved', where: 'Kickoff.md', attachments: 0 });
    expect(downloads.map(({ name, type }) => [name, type])).toEqual([
      ['Kickoff.md', 'text/markdown;charset=utf-8'],
    ]);
    expect(text(downloads[0]!.bytes)).toBe(note);
  });

  it('downloads a note with a picture as a zip whose link leads to the picture inside it', async () => {
    const { run, downloads } = setUp({
      'Projects/Kickoff.md': '# Kickoff\n\n![Chart](chart.png)\n',
      'Projects/chart.png': PICTURE,
    });
    const outcome = await run('standalone', ['Projects/Kickoff.md']);
    expect(outcome).toMatchObject({ where: 'Kickoff.zip', attachments: 1, picturesLeftOut: 0 });
    expect(downloads[0]).toMatchObject({ name: 'Kickoff.zip', type: 'application/zip' });
    const files = unpacked(downloads);
    expect(Object.keys(files).sort()).toEqual(['Kickoff.md', 'attachments/chart.png']);
    const href = /!\[Chart\]\(([^)]+)\)/.exec(text(files['Kickoff.md']))?.[1];
    expect(href).toBe('attachments/chart.png');
    expect(files[decodeURIComponent(href!)]).toEqual(PICTURE);
  });

  it('keeps a note with a picture as it is inside the zip, its picture beside it', async () => {
    const note = '# Kickoff\n\n![Chart](chart.png)\n';
    const { run, downloads } = setUp({ 'Kickoff.md': note, 'chart.png': PICTURE });
    await run('markdown', ['Kickoff.md']);
    const files = unpacked(downloads);
    expect(text(files['Kickoff.md'])).toBe(note);
    expect(files['attachments/chart.png']).toEqual(PICTURE);
  });

  it('downloads several notes as one dated zip, their pictures shared, links between them kept', async () => {
    const { run, downloads } = setUp({
      'Larkspur/Alpha.md': 'Alpha links [[Beta]] ![](diagram.png)\n',
      'Northwind/Beta.md': 'Beta ![](diagram.png)\n',
      'Larkspur/diagram.png': new Uint8Array([1]),
      'Northwind/diagram.png': new Uint8Array([2]),
    });
    const outcome = await run('standalone', ['Larkspur/Alpha.md', 'Northwind/Beta.md']);
    expect(outcome).toMatchObject({ where: 'Exported notes 2026-11-05.zip', notes: 2 });
    expect(downloads[0]!.name).toBe('Exported notes 2026-11-05.zip');
    const files = unpacked(downloads);
    expect(
      Object.keys(files)
        .filter((path) => path.endsWith('.md'))
        .sort(),
    ).toEqual(['Alpha.md', 'Beta.md']);
    expect(Object.keys(files).filter((path) => path.startsWith('attachments/'))).toHaveLength(2);
    const pictureOf = (note: string) =>
      files[decodeURIComponent(/!\[[^\]]*\]\(([^)]+)\)/.exec(text(files[note]))![1]!)];
    expect(pictureOf('Alpha.md')).toEqual(new Uint8Array([1]));
    expect(pictureOf('Beta.md')).toEqual(new Uint8Array([2]));
    expect(text(files['Alpha.md'])).toContain('(Beta.md)');
  });

  it('keeps a title with spaces and accents in the zip as it is', async () => {
    const { run, downloads } = setUp({
      'Café plan.md': '![](<a b.png>)\n',
      'a b.png': PICTURE,
    });
    await run('standalone', ['Café plan.md']);
    expect(downloads[0]!.name).toBe('Café plan.zip');
    expect(Object.keys(unpacked(downloads)).sort()).toEqual([
      'Café plan.md',
      'attachments/a b.png',
    ]);
  });

  it('downloads nothing when a picture cannot be read part-way, and says why', async () => {
    const downloads: DownloadFile[] = [];
    const vault = readOnlyVault({ 'Kickoff.md': '![](chart.png)\n', 'chart.png': PICTURE });
    const files = browserExportFiles({
      download: (file) => {
        downloads.push(file);
        return Promise.resolve();
      },
      loadZip: loadZipFiles,
    });
    const failing = saveExport(
      {
        fs: { ...vault, readBinaryFile: () => Promise.reject(new Error('disk gone')) },
        markdown: remarkMarkdown,
        index: fakeIndexPort(),
        files,
        pdf: { pagingScript: '', render: NOT_USED },
        renderer: { bodyHtml: NOT_USED, styles: '' },
        clock: { today: () => '2026-11-05', now: () => 0, localNow: () => '2026-11-05T09:00:00' },
      },
      {
        format: 'markdown',
        paths: ['Kickoff.md' as VaultPath],
        notePaths: ['Kickoff.md' as VaultPath],
        keepFrontmatter: false,
      },
    );
    await expect(failing).rejects.toThrow('disk gone');
    expect(downloads).toEqual([]);
  });
});
