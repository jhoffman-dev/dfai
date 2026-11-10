import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import {
  mapMeetingScript,
  moduleScript,
  sameMeetingAtOtherPathScript,
  sameMeetingScript,
} from './code-node.ts';

// The compiler, counted: its own exports cannot be spied on, so it is passed through a spy.
vi.mock('typescript', async (importOriginal) => {
  const actual = (await importOriginal<{ default: typeof ts }>()).default;
  return { default: { ...actual, transpileModule: vi.fn(actual.transpileModule) } };
});

/*
 * Every Code node carries the whole mapper. Compiled again for each node, one
 * workflow compiled every module three times over, which is what made its
 * rebuild test slow under load (#820).
 */
describe('the modules compiled into the Code nodes', () => {
  it('compiles each module once, however many Code nodes carry it', () => {
    const compile = vi.mocked(ts.transpileModule);
    compile.mockClear();
    mapMeetingScript();
    sameMeetingScript();
    sameMeetingAtOtherPathScript();
    const compiled = compile.mock.calls.map(([, options]) => options.fileName);
    expect(compiled.length).toBeGreaterThan(0);
    expect(compiled.filter((name, at) => compiled.indexOf(name) !== at)).toEqual([]);
  });

  it('gives back the script it compiled when asked again, without compiling it again', () => {
    const compile = vi.mocked(ts.transpileModule);
    const first = moduleScript('./github-file.ts');
    compile.mockClear();
    expect(moduleScript('./github-file.ts')).toBe(first);
    expect(compile).not.toHaveBeenCalled();
    // Kept by name: another module is its own script, not the one asked for first.
    expect(moduleScript('./sha256.ts')).not.toBe(first);
  });
});
