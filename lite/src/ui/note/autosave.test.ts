import { createAutosave } from './autosave.ts';

describe('autosave', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    const saved: string[] = [];
    const errors: unknown[] = [];
    const autosave = createAutosave({
      save: async (text) => {
        saved.push(text);
      },
      onError: (error) => errors.push(error),
    });
    return { saved, errors, autosave };
  }

  it('saves once, the last text, after typing stops', async () => {
    const { saved, autosave } = setup();
    let text = 'a';
    autosave.schedule(() => text);
    await vi.advanceTimersByTimeAsync(200);
    text = 'ab';
    autosave.schedule(() => text);
    await vi.advanceTimersByTimeAsync(299);
    expect(saved).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(saved).toEqual(['ab']);
  });

  it('flushes at once, and a flush with nothing waiting saves nothing', async () => {
    const { saved, autosave } = setup();
    autosave.schedule(() => 'now');
    await autosave.flush();
    await autosave.flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(saved).toEqual(['now']);
  });

  it('reports a failed save and keeps saving after it', async () => {
    const errors: unknown[] = [];
    const saved: string[] = [];
    const autosave = createAutosave({
      save: async (text) => {
        if (text === 'bad') throw new Error('disk full');
        saved.push(text);
      },
      onError: (error) => errors.push(error),
    });
    autosave.schedule(() => 'bad');
    await autosave.flush();
    autosave.schedule(() => 'good');
    await autosave.flush();
    expect(errors).toEqual([new Error('disk full')]);
    expect(saved).toEqual(['good']);
  });
});
