import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { Icon } from '../icon.tsx';
import { PageAction, PageBar, type PageHistory } from '../page-bar.tsx';
import { HiddenTitle } from '../page-head.tsx';
import { AskAnswer, UncitedCount } from './ask-answer.tsx';
import type { AskActions, AskRecent, AskState } from './ask-view.ts';
import { Composer, ProblemNotice, type ChatDraft } from './chat-panel.tsx';
import type { ChatEntryView, ChatProblemView } from './chat-view.ts';
import { ProposalCard } from './proposal-card.tsx';

export interface AskPageProps {
  readonly state: AskState;
  readonly model: string;
  readonly problem: ChatProblemView | null;
  readonly recent: AskRecent;
  /** Why the recent questions could not be read, or a picked one opened; null when all is well. */
  readonly recentProblem: string | null;
  readonly draft: ChatDraft;
  /**
   * A request that this Ask take the keys — ⌘J, the sidebar's Ask — by its
   * number, or null. A tab brought back at launch, or in the pane not worked
   * in, is not asked, and leaves the focus where it is.
   */
  readonly focusRequest: number | null;
  /** Told once the box has the keys, so a request is taken once. */
  readonly onFocusTaken: () => void;
  readonly actions: AskActions;
  readonly loadImage: (src: string) => Promise<string | null>;
  readonly onShowSidebar?: () => void;
  readonly history?: PageHistory;
}

/** Ask's question box is taller than the sidebar chat's: it is the page. */
const ASK_ROWS = 4;

/**
 * Ask (#37): where a question starts. Before anything is asked, a big box and
 * the questions asked lately; then the conversation, each answer citing the
 * notes it came from, and a box under it for the next question. It draws;
 * the chat session decides, and the app reads the answers for citations.
 */
export function AskPage(props: AskPageProps) {
  const { state, actions, focusRequest, onFocusTaken } = props;
  const asked = state.entries.length > 0;
  const box = useRef<HTMLDivElement>(null);
  const focusBox = () => box.current?.querySelector('textarea')?.focus();
  useEffect(() => {
    if (focusRequest === null) return;
    box.current?.querySelector('textarea')?.focus();
    onFocusTaken();
  }, [focusRequest, onFocusTaken]);
  const newQuestion = () => {
    actions.onNewChat();
    focusBox();
  };
  return (
    <>
      <PageBar
        crumb={{ icon: 'ask', parent: 'Ask' }}
        name="Ask"
        actions={
          asked && (
            <PageAction
              icon="plus"
              label="New question"
              title="New question"
              onPress={newQuestion}
            />
          )
        }
        {...(props.onShowSidebar !== undefined && { onShowSidebar: props.onShowSidebar })}
        {...(props.history !== undefined && { history: props.history })}
      />
      <div className="panel__body">
        <article
          className={asked ? 'page ask' : 'page ask ask--start'}
          aria-label="Ask"
          aria-busy={state.busy || undefined}
        >
          <HiddenTitle>Ask</HiddenTitle>
          {props.problem !== null && (
            <ProblemNotice problem={props.problem} onCopy={actions.onCopy} />
          )}
          {asked ? <Conversation {...props} /> : <Lede />}
          {/* One box in one place, before and after the first question, so sending keeps the keys in it. */}
          <AskBox box={box} draft={props.draft} actions={actions} busy={state.busy} />
          {!asked && <StartFoot {...props} />}
        </article>
      </div>
    </>
  );
}

function Lede() {
  return (
    <p className="ask__lede">
      <Icon name="spark" size={16} className="ask__spark" />
      Ask anything in the vault. Each answer links to the notes it came from.
    </p>
  );
}

function StartFoot({ actions, recent, recentProblem, model }: AskPageProps) {
  return (
    <>
      <p className="ask__model" title="The model, set in Settings → Claude">
        {model}
      </p>
      {recentProblem !== null && (
        <p className="ask__recent-problem" role="alert">
          {recentProblem}
        </p>
      )}
      <Recent recent={recent} onPick={actions.onPickRecent} />
    </>
  );
}

function Recent({ recent, onPick }: { recent: AskRecent; onPick: (path: string) => void }) {
  if (recent === null || recent.length === 0) return null;
  return (
    <nav className="ask__recent" aria-label="Recent questions">
      <h2 className="ask__recent-title">Recent questions</h2>
      <ul>
        {recent.map((chat) => (
          <li key={chat.path}>
            <button type="button" className="ask__recent-row" onClick={() => onPick(chat.path)}>
              <Icon name="history" size={14} />
              <span>{chat.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function Conversation(props: AskPageProps) {
  const { state, actions, loadImage } = props;
  const links = useMemo(
    () => ({ onFollowCitation: actions.onFollowCitation, onOpenWeb: actions.onOpenWeb }),
    [actions.onFollowCitation, actions.onOpenWeb],
  );
  const lastAnswer = [...state.entries].reverse().find((entry) => entry.kind === 'answer');
  return (
    <>
      <div className="ask__log" role="log" aria-label="Conversation">
        {state.entries.map((entry) => (
          <Entry
            key={entry.id}
            entry={entry}
            isLastAnswer={entry === lastAnswer && !state.busy}
            actions={actions}
            links={links}
            loadImage={loadImage}
          />
        ))}
        {state.busy && (
          <p className="ask__thinking" role="status">
            Claude is working…
          </p>
        )}
        {state.error !== null && (
          <div className="chat__error" role="alert">
            <p>{state.error.message}</p>
            <button type="button" className="btn btn--secondary" onClick={actions.onRetry}>
              <Icon name="retry" size={14} /> Retry
            </button>
          </div>
        )}
        {state.notice !== null && <p className="chat__notice">{state.notice}</p>}
      </div>
    </>
  );
}

function AskBox({
  box,
  draft,
  actions,
  busy,
}: Pick<AskPageProps, 'draft' | 'actions'> & {
  box: RefObject<HTMLDivElement | null>;
  busy: boolean;
}) {
  return (
    <div className="ask__box" ref={box}>
      <Composer
        state={{ busy, context: null }}
        // Ask is opened on no page, so there is never a context chip to remove.
        actions={{ ...actions, onRemoveContext: () => {} }}
        draft={draft}
        focusOnMount={false}
        rows={ASK_ROWS}
      />
    </div>
  );
}

function Entry({
  entry,
  isLastAnswer,
  actions,
  links,
  loadImage,
}: {
  entry: ChatEntryView;
  isLastAnswer: boolean;
  actions: AskActions;
  links: Parameters<typeof AskAnswer>[0]['links'];
  loadImage: AskPageProps['loadImage'];
}) {
  switch (entry.kind) {
    case 'user':
      return <h2 className="ask__question">{entry.text}</h2>;
    case 'answer':
      return (
        <section className="ask__reply" aria-label="Answer">
          <AskAnswer answer={entry} links={links} />
          <AnswerFoot entry={entry} isLastAnswer={isLastAnswer} actions={actions} />
        </section>
      );
    case 'tool':
      return (
        <div className="chat__tool" data-state={entry.state}>
          <Icon name={entry.state === 'failed' ? 'close' : 'check'} size={13} />
          <span>{entry.label}</span>
          {entry.detail !== null && <span className="chat__tool-detail">{entry.detail}</span>}
        </div>
      );
    case 'proposal':
      return (
        <ProposalCard
          item={entry}
          onAccept={() => actions.onAccept(entry.id)}
          onReject={() => actions.onReject(entry.id)}
          onUndo={() => actions.onUndo(entry.id)}
          onFollowLink={actions.onFollowLink}
          loadImage={loadImage}
        />
      );
  }
}

function AnswerFoot({
  entry,
  isLastAnswer,
  actions,
}: {
  entry: Extract<ChatEntryView, { kind: 'answer' }>;
  isLastAnswer: boolean;
  actions: AskActions;
}) {
  return (
    <div className="chat__actions ask__foot">
      <UncitedCount answer={entry} />
      <button
        type="button"
        className="icon-button"
        aria-label="Copy answer"
        title="Copy"
        onClick={() => actions.onCopy(entry.text)}
      >
        <Icon name="copy" size={14} />
      </button>
      {isLastAnswer && (
        <button
          type="button"
          className="icon-button"
          aria-label="Retry"
          title="Ask again"
          onClick={actions.onRetry}
        >
          <Icon name="retry" size={14} />
        </button>
      )}
    </div>
  );
}
