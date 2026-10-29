import { useEffect, useState, type KeyboardEvent, type RefObject } from 'react';
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
      {chip.problem !== null && (
        <span className="chat__skill-problem" role="alert">
          {chip.problem}
        </span>
      )}
    </span>
  );
}

const UNUSABLE: Record<NonNullable<SkillChoice['unusable']>, string> = {
  problems: 'has problems',
  'too-long': 'too long',
};

/**
 * The vault's skills to attach one from, narrowed to those starting with
 * `query` when `/` was typed. Escape closes it.
 */
export function SkillPicker({
  choices,
  query,
  onPick,
  onClose,
}: {
  choices: readonly SkillChoice[];
  query: string;
  onPick: (name: string) => void;
  onClose: () => void;
}) {
  const wanted = query.toLowerCase();
  const shown = choices.filter((choice) => choice.name.toLowerCase().startsWith(wanted));
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') onClose();
  };
  return (
    <div className="chat__skill-picker" role="group" aria-label="Skills" onKeyDown={onKeyDown}>
      {shown.length === 0 ? (
        <p className="chat__skill-empty">
          {query === ''
            ? 'No skills yet. Add one on the Skills page.'
            : `No skill starts with /${query}.`}
        </p>
      ) : (
        <ul>
          {shown.map((choice) => (
            <li key={choice.name}>
              <button type="button" onClick={() => onPick(choice.name)}>
                <Icon name="skill" size={13} />
                <span>{choice.name}</span>
                {choice.unusable !== null && (
                  <>
                    {' '}
                    <span className="chat__skill-unusable">{UNUSABLE[choice.unusable]}</span>
                  </>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Whether the skill picker shows, and what it narrows to: opened by its
 * button, or by typing `/` and the start of a name, until Escape or a pick.
 * The app is asked for the skills only once it shows.
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
}) {
  const [opened, setOpened] = useState(false);
  /** The draft whose `/` picker was closed: it stays closed until the draft changes. */
  const [dismissed, setDismissed] = useState<string | null>(null);
  const typed = skills === undefined ? null : skillQueryOf(draft);
  const slash = typed !== null && dismissed !== draft;
  const showing = skills !== undefined && (opened || slash);
  const onWanted = skills?.onWanted;
  useEffect(() => {
    if (showing) onWanted?.();
  }, [showing, onWanted]);
  return {
    showing,
    query: slash ? typed : '',
    toggle: () => setOpened((open) => !open),
    pick: (name: string) => {
      skills?.onAttach(name);
      setOpened(false);
      // The `/name` typed was the pick, not a question.
      if (slash) setDraft('');
      box.current?.focus();
    },
    close: () => {
      setOpened(false);
      setDismissed(draft);
      box.current?.focus();
    },
  };
}
