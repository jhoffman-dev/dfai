// @vitest-environment jsdom
/**
 * Attack on PR #634 (#169): Ask Claude's state machine under seeded
 * sequences of ask, type, answer (early, late, after Stop / Cancel / New /
 * unmount), Accept, Discard and Ask again, against a provider that ignores
 * the signal and answers whenever the test says. Only what the page offers
 * at each moment is pressed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { useEffect, useState } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import type { SkillDraft, SkillLineChange } from '@dfai/domain';
import type { ModelEvent, ModelProvider } from '@dfai/application';
import type { SkillAskView, SkillEditorState } from '@dfai/ui';
import { useSkillDraft } from './use-skill-draft.ts';

// The answers below arrive between acts, as a real provider's would.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(cleanup);

function seeded(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, pick: <T,>(items: readonly T[]) => items[Math.floor(next() * items.length)] as T };
}

const SAVED: SkillDraft = {
  name: 'meeting-notes',
  description: 'Summarises meeting notes for Mara Quill.',
  instructions: 'List the decisions.\nList the owners.\nList the dates.\nKeep it short.\nEnd.',
};
const BLANK: SkillDraft = { name: '', description: '', instructions: '' };

/** A provider deaf to Stop: every ask waits until the test answers it, by number. */
function deafModel() {
  const waiting = new Map<number, (text: string) => void>();
  let asked = 0;
  const provider: ModelProvider = {
    id: 'claude-code',
    status: async () => ({ ready: true }),
    async *stream(): AsyncIterable<ModelEvent> {
      asked += 1;
      const number = asked;
      const text = await new Promise<string>((resolve) => waiting.set(number, resolve));
      yield { type: 'text', text };
    },
  };
  return {
    provider,
    asked: () => asked,
    pending: () => [...waiting.keys()],
    answer: (number: number, text: string) => {
      const resolve = waiting.get(number);
      waiting.delete(number);
      resolve?.(text);
    },
  };
}

function editorOf(mode: 'new' | 'edit', draft: SkillDraft): SkillEditorState {
  return {
    mode,
    draft,
    problems: [],
    fileProblems: [],
    descriptionLength: draft.description.length,
    descriptionLimit: 1024,
    changedOnDisk: false,
    saving: false,
    canSave: true,
    justCreated: false,
    saveRefusal: null,
    deleting: false,
  };
}

interface Shown {
  readonly mode: 'new' | 'edit';
  readonly draft: SkillDraft;
  readonly opening: number;
}

/** What the test reaches through: the ask as drawn, the editor, and the page's own actions. */
interface Drawn {
  ask: SkillAskView | undefined;
  shown: Shown;
  type: (change: Partial<SkillDraft>) => void;
  openNew: () => void;
}

function Harness({
  provider,
  onDrawn,
  onAccepted,
}: {
  provider: ModelProvider;
  onDrawn: (drawn: Drawn) => void;
  onAccepted: (change: Partial<SkillDraft>) => void;
}) {
  const [shown, setShown] = useState<Shown>({ mode: 'edit', draft: SAVED, opening: 1 });
  const ask = useSkillDraft({
    ports: { provider: () => provider, model: () => 'claude-opus-5-5' },
    editor: editorOf(shown.mode, shown.draft),
    opening: shown.opening,
    onChange: (change) => {
      onAccepted(change);
      setShown((was) => ({ ...was, draft: { ...was.draft, ...change } }));
    },
  });
  // Every commit is handed out, so the test reads the page as last drawn.
  useEffect(() => {
    onDrawn({
      ask,
      shown,
      type: (change) => setShown((was) => ({ ...was, draft: { ...was.draft, ...change } })),
      openNew: () => setShown((was) => ({ mode: 'new', draft: BLANK, opening: was.opening + 1 })),
    });
  });
  return null;
}

/** The answer to ask `number`: each draft says which ask it answers. */
const answerFor = (number: number) =>
  JSON.stringify({
    name: `draft-${number}`,
    description: `Draft ${number} description.`,
    instructions: `List the decisions.\nDraft ${number} line.\nEnd.`,
  });

/** The text `changes` turns `before` into: folded and same lines are taken from `before`. */
function applied(before: string, changes: readonly SkillLineChange[]): string {
  const from = before === '' ? [] : before.split('\n');
  const out: string[] = [];
  let at = 0;
  for (const change of changes) {
    if (change.kind === 'folded') {
      out.push(...from.slice(at, at + change.count));
      at += change.count;
    } else if (change.kind === 'same') {
      expect(from[at]).toBe(change.text);
      out.push(change.text);
      at += 1;
    } else if (change.kind === 'removed') {
      expect(from[at]).toBe(change.text);
      at += 1;
    } else out.push(change.text);
  }
  expect(at).toBe(from.length);
  return out.join('\n');
}

const flush = () => act(() => new Promise<void>((done) => setTimeout(done, 0)));

type Step =
  'open' | 'request' | 'ask' | 'answer' | 'stop' | 'cancel' | 'type' | 'new' | 'accept' | 'discard';
const STEPS: readonly Step[] = [
  ...([
    'open',
    'request',
    'request',
    'ask',
    'ask',
    'ask',
    'answer',
    'answer',
    'answer',
    'answer',
  ] as const),
  ...(['accept', 'accept', 'accept', 'stop', 'cancel', 'type', 'type', 'new', 'discard'] as const),
];

async function runSequence(seed: number) {
  const rng = seeded(seed);
  const model = deafModel();
  const accepted: Partial<SkillDraft>[] = [];
  let probe = null as unknown as Drawn;
  const { unmount } = render(
    <Harness
      provider={model.provider}
      onAccepted={(change) => accepted.push(change)}
      onDrawn={(drawn) => {
        probe = drawn;
      }}
    />,
  );
  // The ask whose answer may be shown, with the editor it was asked in; null when none may be.
  let live: { number: number; opening: number } | null = null;
  let acceptsOffered = 0;
  const trail: string[] = [];
  for (let move = 0; move < 60; move += 1) {
    const step = rng.pick(STEPS);
    const ask = probe.ask;
    if (ask === undefined) throw new Error('the editor is always open here');
    trail.push(step);
    const where = `seed ${seed}: ${trail.join(' → ')}`;
    if (step === 'open' && !ask.open) await act(() => ask.onOpen());
    else if (step === 'request' && ask.open && !ask.asking)
      await act(() =>
        ask.onRequestChange(rng.pick(['Make it shorter', 'Add a step', 'Add a step', '  '])),
      );
    else if (step === 'ask' && ask.open && !ask.asking && ask.request.trim() !== '') {
      await act(() => ask.onAsk());
      await flush();
      live = { number: model.asked(), opening: probe.shown.opening };
    } else if (step === 'answer' && model.pending().length > 0) {
      const number = rng.pick(model.pending());
      await act(() => model.answer(number, answerFor(number)));
      await flush();
    } else if (step === 'stop' && ask.asking) {
      await act(() => ask.onStop());
      live = null;
    } else if (step === 'cancel' && ask.open && !ask.asking && ask.preview === null) {
      await act(() => ask.onClose());
      live = null;
    } else if (step === 'type') {
      await act(() => probe.type({ description: `Typed ${move}.` }));
    } else if (step === 'new') {
      await act(() => probe.openNew());
      live = null;
    } else if (step === 'accept' && ask.preview !== null && !ask.asking) {
      const before = probe.shown;
      const preview = ask.preview;
      acceptsOffered += 1;
      await act(() => ask.onAccept());
      const after = probe.shown.draft;
      // Accept is exactly the preview.
      expect(after.description, where).toBe(applied(before.draft.description, preview.description));
      expect(after.instructions, where).toBe(
        applied(before.draft.instructions, preview.instructions),
      );
      expect(after.name, where).toBe(preview.name ?? before.draft.name);
      if (before.mode === 'edit') expect(after.name, where).toBe(SAVED.name);
      live = null;
    } else if (step === 'discard' && ask.preview !== null && !ask.asking) {
      await act(() => ask.onDiscard());
      live = null;
    }
    // A preview is only ever the live ask's answer, in the editor it was asked in.
    const preview = probe.ask?.preview ?? null;
    if (preview !== null) {
      expect(live, where).not.toBeNull();
      expect(live?.opening, where).toBe(probe.shown.opening);
      const added = preview.description.filter((change) => change.kind === 'added');
      expect(
        added.map((change) => (change.kind === 'added' ? change.text : '')),
        where,
      ).toEqual([`Draft ${live?.number} description.`]);
    }
  }
  // Every change to the editor through the ask came from an Accept offered on screen.
  expect(accepted.length).toBe(acceptsOffered);
  // Unmounted with asks still out: their late answers change nothing.
  const before = accepted.length;
  unmount();
  for (const number of model.pending()) model.answer(number, answerFor(number));
  await flush();
  expect(accepted.length).toBe(before);
  return acceptsOffered;
}

describe('Ask Claude under seeded sequences (attack-634)', () => {
  it('shows only the live ask’s draft, Accept is the preview, and nothing else changes the editor, over 300 seeds', async () => {
    let accepts = 0;
    for (let seed = 1; seed <= 300; seed += 1) {
      accepts += await runSequence(seed);
      cleanup();
    }
    // The sequences reach Accept often enough for the invariant to mean something.
    expect(accepts).toBeGreaterThan(40);
  }, 120_000);
});
