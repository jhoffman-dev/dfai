// @vitest-environment jsdom
import { Profiler, Suspense, useState, type ComponentType, type ElementType } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { chunkOf, onFirstUse, type FailedPartProps } from './on-first-use.ts';

type Named = { name: string };

function Greeting({ name }: Named) {
  return <p>Hello, {name}</p>;
}
function Farewell({ name }: Named) {
  return <p>Goodbye, {name}</p>;
}
const MODULE = { Greeting, Farewell };
type Parts = typeof MODULE;

/** Says what failed, with the props it was given, and the buttons the outcome offers. */
function Failed({ props, retrying, onRetry, onReloadWindow }: FailedPartProps<Named>) {
  return (
    <div role="alert">
      <button type="button" disabled={retrying} onClick={onRetry}>
        Reload for {props.name}
      </button>
      {onReloadWindow !== null && (
        <button type="button" onClick={onReloadWindow}>
          Reload window
        </button>
      )}
    </div>
  );
}

const FETCH_FAILED = () => new TypeError('Importing a module script failed.');
const PARSE_FAILED = () => new SyntaxError('Unexpected end of script');

/** A chunk whose imports answer in turn from `answers`; the last answer repeats. */
function scriptedChunk(answers: (Error | Parts)[], again: (Error | Parts)[] = []) {
  const answer = (list: (Error | Parts)[], index: number): Promise<Parts> => {
    const next = list[Math.min(index, list.length - 1)];
    if (next === undefined || next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  };
  const load = vi.fn(() => answer(answers, load.mock.calls.length - 1));
  // Each fresh copy answers in turn; which attempt asked is checked by the tests.
  const loadAgain = vi.fn<(attempt: number) => Promise<Parts> | null>();
  loadAgain.mockImplementation(() =>
    again.length === 0 ? null : answer(again, loadAgain.mock.calls.length - 1),
  );
  return { chunk: chunkOf<Parts>({ load, loadAgain }), load, loadAgain };
}

function partOf(
  chunk: ReturnType<typeof scriptedChunk>['chunk'],
  pick: (m: Parts) => ComponentType<Named> = (m) => m.Greeting,
  reloadWindow = vi.fn(),
) {
  return onFirstUse({ chunk, pick, Failed, reloadWindow });
}

/** What the page showed at each commit, after a click opens the component. */
async function commitsOnOpen(Component: ElementType<Named>) {
  const shown: string[] = [];
  function Host() {
    const [open, setOpen] = useState(false);
    return (
      <Profiler id="host" onRender={() => shown.push(document.body.textContent ?? '')}>
        <button onClick={() => setOpen(true)}>Open</button>
        <Suspense fallback={<p>Loading</p>}>{open && <Component name="Mara" />}</Suspense>
      </Profiler>
    );
  }
  render(<Host />);
  shown.length = 0;
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  });
  return shown;
}

/** Parts beside an editor that must outlive them, as a page sits beside the sidebar. */
function renderBesideEditor(...Components: ElementType<Named>[]) {
  return render(
    <>
      <textarea aria-label="Editor" defaultValue="unsaved words" />
      {Components.map((Component, index) => (
        <Suspense key={index} fallback={<p>Loading</p>}>
          <Component name={`Mara ${index + 1}`} />
        </Suspense>
      ))}
    </>,
  );
}

const reloadButton = (name = 'Mara 1') =>
  screen.findByRole('button', { name: `Reload for ${name}` });

describe('onFirstUse', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('loads nothing until it is wanted', () => {
    const { chunk, load } = scriptedChunk([MODULE]);
    partOf(chunk);
    expect(load).not.toHaveBeenCalled();
  });

  it('shows the fallback while its chunk loads, then the component', async () => {
    const shown = await commitsOnOpen(partOf(scriptedChunk([MODULE]).chunk).Component);
    expect(shown[0]).toBe('OpenLoading');
    expect(shown.at(-1)).toBe('OpenHello, Mara');
  });

  it('draws a preloaded component in one commit, with no fallback', async () => {
    const { chunk, load } = scriptedChunk([MODULE]);
    const greeting = partOf(chunk);
    await greeting.preload();
    expect(await commitsOnOpen(greeting.Component)).toEqual(['OpenHello, Mara']);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('imports a chunk once for all its parts, however often they are preloaded', async () => {
    const { chunk, load } = scriptedChunk([MODULE]);
    const greeting = partOf(chunk);
    const farewell = partOf(chunk, (m) => m.Farewell);
    await Promise.all([greeting.preload(), farewell.preload(), greeting.preload()]);
    await farewell.preload();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('leaves a part whose preload failed unloaded, so its first open imports again', async () => {
    const { chunk, load } = scriptedChunk([FETCH_FAILED(), MODULE]);
    const greeting = partOf(chunk);
    await expect(greeting.preload()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('A part of DFAI could not load:', expect.any(TypeError));
    renderBesideEditor(greeting.Component);
    expect(await screen.findByText('Hello, Mara 1')).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('draws a part whose chunk cannot be loaded as failed, and leaves the rest mounted', async () => {
    renderBesideEditor(partOf(scriptedChunk([FETCH_FAILED()]).chunk).Component);
    expect(await reloadButton()).toBeDefined();
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Editor' }).value).toBe(
      'unsaved words',
    );
    expect(screen.queryByRole('button', { name: 'Reload window' })).toBeNull();
  });

  it('imports the chunk again on Reload, and every failed part of it draws', async () => {
    const { chunk, load } = scriptedChunk([FETCH_FAILED(), MODULE]);
    renderBesideEditor(partOf(chunk).Component, partOf(chunk, (m) => m.Farewell).Component);
    await userEvent.click(await reloadButton('Mara 1'));
    expect(await screen.findByText('Hello, Mara 1')).toBeDefined();
    expect(await screen.findByText('Goodbye, Mara 2')).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
    // The two failed opens shared one import, and the Reload made one more.
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('draws a part of a chunk that another part has since loaded, with no Reload of its own', async () => {
    const { chunk } = scriptedChunk([FETCH_FAILED(), MODULE]);
    const greeting = partOf(chunk);
    const farewell = partOf(chunk, (m) => m.Farewell);
    const first = renderBesideEditor(greeting.Component);
    await reloadButton();
    first.unmount();
    // A part never drawn imports the chunk afresh, and the failed one recovers with it.
    renderBesideEditor(farewell.Component, greeting.Component);
    expect(await screen.findByText('Goodbye, Mara 1')).toBeDefined();
    expect(await screen.findByText('Hello, Mara 2')).toBeDefined();
  });

  it('fetches a fresh copy on Reload when the module itself failed, as a cut-short file does', async () => {
    const { chunk, load, loadAgain } = scriptedChunk([PARSE_FAILED()], [MODULE]);
    renderBesideEditor(partOf(chunk).Component);
    await userEvent.click(await reloadButton());
    expect(await screen.findByText('Hello, Mara 1')).toBeDefined();
    expect(load).toHaveBeenCalledTimes(1);
    expect(loadAgain).toHaveBeenCalledWith(2);
  });

  it('still fetches a fresh copy on Reload when a fetch failed after the module itself had', async () => {
    const { chunk, load, loadAgain } = scriptedChunk([PARSE_FAILED(), FETCH_FAILED()], [MODULE]);
    const greeting = partOf(chunk);
    await greeting.preload();
    renderBesideEditor(greeting.Component);
    await userEvent.click(await reloadButton());
    expect(await screen.findByText('Hello, Mara 1')).toBeDefined();
    expect(load).toHaveBeenCalledTimes(2);
    expect(loadAgain).toHaveBeenCalledWith(3);
  });

  it('imports the same file again on Reload when only the fetch failed', async () => {
    const { chunk, load, loadAgain } = scriptedChunk([FETCH_FAILED(), MODULE], [MODULE]);
    renderBesideEditor(partOf(chunk).Component);
    await userEvent.click(await reloadButton());
    expect(await screen.findByText('Hello, Mara 1')).toBeDefined();
    expect(load).toHaveBeenCalledTimes(2);
    expect(loadAgain).not.toHaveBeenCalled();
  });

  it('offers to reload the window once Reload has failed too, and stays retryable', async () => {
    const reloadWindow = vi.fn();
    const { chunk } = scriptedChunk([PARSE_FAILED()], [PARSE_FAILED()]);
    renderBesideEditor(partOf(chunk, (m) => m.Greeting, reloadWindow).Component);
    const reload = await reloadButton();
    expect(screen.queryByRole('button', { name: 'Reload window' })).toBeNull();
    await userEvent.click(reload);
    await userEvent.click(await screen.findByRole('button', { name: 'Reload window' }));
    expect(reloadWindow).toHaveBeenCalledTimes(1);
    expect(reload.hasAttribute('disabled')).toBe(false);
  });

  it('catches a module that throws as it is evaluated', async () => {
    const broken = onFirstUse({
      chunk: chunkOf({
        load: () => import('./throws-when-evaluated.fixture.ts'),
        loadAgain: () => null,
      }),
      pick: (m) => m.Broken as never,
      Failed,
      reloadWindow: vi.fn(),
    });
    renderBesideEditor(broken.Component);
    expect(await reloadButton()).toBeDefined();
    expect(screen.getByRole('textbox', { name: 'Editor' })).toBeDefined();
    expect(warn).toHaveBeenCalledWith(
      'A part of DFAI could not load:',
      expect.objectContaining({ message: 'broken while evaluating' }),
    );
  });
});
