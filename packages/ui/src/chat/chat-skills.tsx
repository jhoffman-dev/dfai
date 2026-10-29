import { useEffect, useId, useState, type KeyboardEvent, type RefObject } from 'react';
import { skillQueryOf } from '@dfai/domain';
import type { SkillChoice } from '../automations/index.ts';
import { Icon } from '../icon.tsx';
import type { ChatSkillChipView, ChatSkillsView } from './chat-view.ts';

/**
 * The skill attached to the chat (#169): a chip that can be taken off, saying
 * why the skill cannot be asked with when it cannot.
 */
export function SkillChip({ chip, onRemove }: { chip: ChatSkillChipView; onRemove: () => void }) {
  return (
    <span className="chat__skill" data-problem={chip.problem !== null || undefined}>
      <span className="chat__context chat__skill-chip">
        <Icon name="skill" size={13} />
        <span className="chat__context-title">{chip.name}</span>
        <button
          type="button"
          className="chat__context-remove"
          aria-label={`Remove the skill ${chip.name} from the chat`}
          title="Ask without this skill"
          onClick={onRemove}
        >
          <Icon name="close" size={11} />
        </button>
      </span>
      {/* Said by the composer's live region, or by the turn's own alert: not twice. */}
      {chip.problem !== null && <span className="chat__skill-problem">{chip.problem}</span>}
    </span>
  );
}

const UNUSABLE: Record<NonNullable<SkillChoice['unusable']>, string> = {
  problems: 'has problems',
  'too-long': 'too long',
};

/**
 * The vault's skills to attach one from, as a listbox the question box
 * controls: the box keeps the keys, and `active` is the option the arrow keys
 * are on. A click picks too.
 */
export function SkillPicker({
  picker,
  onPick,
}: {
  picker: Pick<SkillPickerState, 'listId' | 'matches' | 'active' | 'optionId' | 'saying'>;
  onPick: (name: string) => void;
}) {
  const { listId, matches, active, optionId, saying } = picker;
  return (
    <div className="chat__skill-picker">
      {matches.length === 0 && <p className="chat__skill-empty">{saying}</p>}
      <ul role="listbox" id={listId} aria-label="Skills" hidden={matches.length === 0}>
        {matches.map((choice, at) => (
          <li
            key={choice.name}
            id={optionId(at)}
            role="option"
            aria-selected={at === active}
            // The box keeps the keys: a click picks without taking them from it.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onPick(choice.name)}
          >
            <Icon name="skill" size={13} />
            <span>{choice.name}</span>
            {choice.unusable !== null && (
              <>
                {' '}
                <span className="chat__skill-unusable">{UNUSABLE[choice.unusable]}</span>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What the picker says of its matches: the count, or why there are none. */
function matchesSaying(count: number, query: string): string {
  if (count === 1) return '1 skill matches';
  if (count > 1) return `${count} skills match`;
  return query === ''
    ? 'No skills yet. Add one on the Skills page.'
    : `No skill starts with /${query}.`;
}

export interface SkillPickerState {
  readonly showing: boolean;
  readonly listId: string;
  readonly matches: readonly SkillChoice[];
  /** The option the arrow keys are on. */
  readonly active: number;
  readonly optionId: (at: number) => string;
  /** The count of matches, or why there are none, for the composer's live region. */
  readonly saying: string;
  /** Handles a key in the box the picker belongs to; true when it took it. */
  readonly onKey: (event: KeyboardEvent) => boolean;
  readonly toggle: () => void;
  readonly pick: (name: string) => void;
}

/**
 * Whether the skill picker shows, and what it narrows to: opened by its
 * button, or by typing `/` and the start of a name, until Escape, a pick, or
 * (opened by the button) anything typed. The app is asked for the skills only
 * once it shows.
 */
export function useSkillPicker({
  skills,
  draft,
  setDraft,
  box,
}: {
  skills: ChatSkillsView | undefined;
  draft: string;
  setDraft: (text: string) => void;
  box: RefObject<HTMLTextAreaElement | null>;
}): SkillPickerState {
  const listId = useId();
  /** The draft the button opened the picker over: typing closes it. */
  const [openedOver, setOpenedOver] = useState<string | null>(null);
  /** The draft whose `/` picker was closed: it stays closed until the draft changes. */
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [arrowed, setArrowed] = useState({ over: '', at: 0 });
  const typed = skills === undefined ? null : skillQueryOf(draft);
  const slash = typed !== null && dismissed !== draft;
  const showing = skills !== undefined && (openedOver === draft || slash);
  const query = slash ? typed : '';
  const wanted = query.toLowerCase();
  const matches = showing
    ? (skills?.choices ?? []).filter((choice) => choice.name.toLowerCase().startsWith(wanted))
    : [];
  const active = arrowed.over === draft ? Math.min(arrowed.at, matches.length - 1) : 0;
  const onWanted = skills?.onWanted;
  useEffect(() => {
    if (showing) onWanted?.();
  }, [showing, onWanted]);

  const pick = (name: string) => {
    skills?.onAttach(name);
    setOpenedOver(null);
    // The `/name` typed was the pick, not a question.
    if (slash) setDraft('');
    box.current?.focus();
  };
  const onKey = (event: KeyboardEvent): boolean => {
    if (!showing) return false;
    if (event.key === 'Escape') {
      setOpenedOver(null);
      setDismissed(draft);
      return true;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setArrowed({ over: draft, at: Math.max(0, Math.min(matches.length - 1, active + step)) });
      return true;
    }
    const chosen = matches[active];
    if (event.key !== 'Enter' || event.shiftKey || chosen === undefined) return false;
    pick(chosen.name);
    return true;
  };
  return {
    showing,
    listId,
    matches,
    active,
    optionId: (at) => `${listId}-${at}`,
    saying: matchesSaying(matches.length, query),
    onKey,
    toggle: () => {
      setOpenedOver((over) => (over === draft ? null : draft));
      box.current?.focus();
    },
    pick,
  };
}
