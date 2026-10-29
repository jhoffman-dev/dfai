import { useState, type FormEvent } from 'react';
import { ChoiceSelect } from '../choice-select.tsx';
import { SettingsSection } from '../settings-section.tsx';
import { SETTINGS_SECTIONS } from '../settings-section-links.ts';
import { Toggle } from '../toggle.tsx';
import {
  RepositoryPicker,
  type RepositoryChoice,
  type RepositoryListView,
} from './repository-picker.tsx';

export type SyncTone = 'quiet' | 'paused' | 'busy' | 'ok' | 'behind' | 'warning' | 'error';

/** Settings → Sync, as the app has worked it out. */
export interface SyncSettingsView {
  readonly stage: 'checking' | 'not-set-up' | 'refused' | 'set-up';
  /** How it stands, in a few words: "Synced at 14:05", "Syncing…". */
  readonly statusLine: string;
  readonly tone: SyncTone;
  /** Why the last sync or setup failed, or why this vault cannot sync. */
  readonly problem: string | null;
  readonly remote: string | null;
  readonly suggestedName: string;
  readonly busy: boolean;
  /** How long after the last change it is sent, in seconds, and the choices offered. */
  readonly pushDelaySeconds: number;
  readonly pushDelayChoices: readonly number[];
  /** How often other Macs' changes are looked for, in minutes, and the choices offered. */
  readonly pullIntervalMinutes: number;
  readonly pullIntervalChoices: readonly number[];
  /** Whether sync is paused on this Mac. */
  readonly paused: boolean;
  readonly thisMac: string;
  /** The Mac that runs automations, by name; null when none is named. */
  readonly automationsMac: string | null;
  readonly automationsHere: boolean;
  /** Whether this Mac's claim of the automations is waiting for its turn or being written. */
  readonly claiming: boolean;
  /** Files the last sync could not leave in one place, and where the other version went. */
  readonly conflicts: readonly {
    readonly path: string;
    readonly copy: string;
    readonly whose: 'theirs' | 'ours';
  }[];
  /** What stays on this Mac unsynced: files over GitHub's limit, repositories of their own. */
  readonly notSynced: readonly string[];
  /** DFAI's own files a line of the vault's `.gitignore` keeps out of sync. */
  readonly ignored: readonly string[];
  /** The person's GitHub repositories, for connecting one. */
  readonly repositories: RepositoryListView;
}

export interface SyncSettingsActions {
  readonly onCreate: (name: string) => void;
  readonly onConnect: (url: string) => void;
  readonly onSyncNow: () => void;
  readonly onPushDelay: (seconds: number) => void;
  readonly onPullInterval: (minutes: number) => void;
  readonly onPause: (paused: boolean) => void;
  readonly onClaimAutomations: () => void;
  readonly onLoadRepositories: () => void;
  /** The repositories a search in the picker finds. */
  readonly findRepositories: (query: string) => readonly RepositoryChoice[];
}

/**
 * Settings → Sync (U-29): sync this vault between Macs through a private
 * GitHub repository, using the GitHub login already on this Mac.
 */
export function SyncSettings({
  view,
  ...actions
}: { view: SyncSettingsView } & SyncSettingsActions) {
  return (
    <SettingsSection section={SETTINGS_SECTIONS.sync}>
      <p className="settings__lede">
        Keep this vault the same on each of your Macs through a private GitHub repository. DFAI uses
        the GitHub login already on this Mac and never stores it. Secrets stay in each Mac’s
        Keychain.
      </p>
      <div className="settings__row">
        <span className="settings__row-text">
          <span className="settings__row-label">Status</span>
          <span
            className={`settings__status sync-status sync-status--${view.tone}`}
            data-testid="sync-status"
          >
            {view.statusLine}
          </span>
        </span>
        {view.stage === 'set-up' && (
          <button
            className="btn btn--secondary"
            type="button"
            disabled={view.busy}
            onClick={actions.onSyncNow}
          >
            Sync now
          </button>
        )}
      </div>
      {view.problem !== null && (
        <p className="settings__problem" role="alert">
          {view.problem}
        </p>
      )}
      <ConflictWarning conflicts={view.conflicts} />
      <NotSynced paths={view.notSynced} ignored={view.ignored} />
      {view.stage === 'not-set-up' && <SetUpForms view={view} {...actions} />}
      {view.stage === 'set-up' && <SyncedControls view={view} {...actions} />}
    </SettingsSection>
  );
}

function ConflictWarning({ conflicts }: { conflicts: SyncSettingsView['conflicts'] }) {
  if (conflicts.length === 0) return null;
  const files = conflicts.length === 1 ? 'a file' : `${conflicts.length} files`;
  return (
    <div className="sync-conflicts" role="status">
      <p className="sync-conflicts__title">
        {conflicts.every(({ whose }) => whose === 'theirs')
          ? `Both Macs changed ${files}. This Mac’s version was kept; the other Mac’s is saved beside it.`
          : `Both Macs changed ${files}, or made them under names that differ only in case. Both Macs’ versions are kept.`}
      </p>
      <ul className="sync-conflicts__list">
        {conflicts.map(({ path, copy, whose }) => (
          <li key={copy}>
            <code>{path}</code> → <code>{copy}</code>{' '}
            {whose === 'theirs' ? '(the other Mac’s)' : '(this Mac’s)'}
          </li>
        ))}
      </ul>
    </div>
  );
}

function NotSynced({ paths, ignored }: { paths: readonly string[]; ignored: readonly string[] }) {
  if (paths.length === 0 && ignored.length === 0) return null;
  return (
    <div className="sync-conflicts" role="status">
      <p className="sync-conflicts__title">Staying on this Mac, not synced</p>
      <ul className="sync-conflicts__list">
        {paths.map((path) => (
          <li key={path}>
            <code>{path}</code>{' '}
            {path.endsWith('/')
              ? 'is a git repository of its own'
              : 'is over GitHub’s 100 MB limit'}
          </li>
        ))}
        {ignored.map((path) => (
          <li key={`ignored:${path}`}>
            <code>{path}</code> is left out by this vault’s .gitignore
          </li>
        ))}
      </ul>
    </div>
  );
}

function SetUpForms({
  view,
  onCreate,
  onConnect,
  onLoadRepositories,
  findRepositories,
}: { view: SyncSettingsView } & SyncSettingsActions) {
  const [name, setName] = useState(view.suggestedName);
  const [url, setUrl] = useState('');
  const submit = (event: FormEvent, act: () => void) => {
    event.preventDefault();
    act();
  };
  return (
    <>
      <RepositoryPicker
        list={view.repositories}
        find={findRepositories}
        busy={view.busy}
        onLoad={onLoadRepositories}
        onConnect={onConnect}
      />
      <form
        className="sync-form"
        aria-label="Set up sync with GitHub"
        onSubmit={(event) => submit(event, () => onCreate(name.trim()))}
      >
        <label className="sync-form__label" htmlFor="sync-repository-name">
          Or create a new private repository
        </label>
        <input
          id="sync-repository-name"
          className="field sync-form__field"
          value={name}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setName(event.target.value)}
        />
        <button
          className="btn btn--primary"
          type="submit"
          disabled={view.busy || name.trim() === ''}
        >
          Set up sync with GitHub
        </button>
      </form>
      <form
        className="sync-form"
        aria-label="Connect an existing repository"
        onSubmit={(event) => submit(event, () => onConnect(url))}
      >
        <label className="sync-form__label" htmlFor="sync-repository-url">
          Or paste an address
        </label>
        <input
          id="sync-repository-url"
          className="field sync-form__field"
          value={url}
          placeholder="git@github.com:you/notes.git"
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setUrl(event.target.value)}
        />
        <button
          className="btn btn--secondary"
          type="submit"
          disabled={view.busy || url.trim() === ''}
        >
          Connect existing repo
        </button>
      </form>
    </>
  );
}

function seconds(value: number): string {
  if (value < 60) return `${value} seconds after a change`;
  const minutes = value / 60;
  return minutes === 1 ? 'A minute after a change' : `${minutes} minutes after a change`;
}

function minutes(value: number): string {
  return value === 1 ? 'Every minute' : `Every ${value} minutes`;
}

function SyncedControls({
  view,
  onPushDelay,
  onPullInterval,
  onPause,
  onClaimAutomations,
}: { view: SyncSettingsView } & SyncSettingsActions) {
  const holder = view.automationsMac ?? 'every Mac';
  return (
    <>
      {view.remote !== null && (
        <p className="settings__file">
          Repository <code>{view.remote}</code>
        </p>
      )}
      <div className="settings__row">
        <span className="settings__row-text">
          <span className="settings__row-label">Send changes</span>
          <span className="settings__status">
            At least every 5 minutes while you keep working, and before quitting
          </span>
        </span>
        <ChoiceSelect
          label="When to send changes"
          className="field sync-interval"
          value={String(view.pushDelaySeconds)}
          choices={view.pushDelayChoices.map((value) => ({
            value: String(value),
            label: seconds(value),
          }))}
          onChange={(value) => onPushDelay(Number(value))}
        />
      </div>
      <div className="settings__row">
        <span className="settings__row-text">
          <span className="settings__row-label">Bring in other Macs’ changes</span>
          <span className="settings__status">Also as the vault opens</span>
        </span>
        <ChoiceSelect
          label="How often to look for other Macs’ changes"
          className="field sync-interval"
          value={String(view.pullIntervalMinutes)}
          choices={view.pullIntervalChoices.map((value) => ({
            value: String(value),
            label: minutes(value),
          }))}
          onChange={(value) => onPullInterval(Number(value))}
        />
      </div>
      <div className="settings__row">
        <span className="settings__row-text">
          <span className="settings__row-label">Pause sync on this Mac</span>
          <span className="settings__status">
            {view.paused
              ? `Nothing is sent or brought in until you turn this off, or press Sync now.${view.automationsHere ? ' Automations on this Mac wait too: no meeting is imported and no Claude step runs until sync resumes.' : ''}`
              : 'Your other Macs keep syncing either way.'}
          </span>
        </span>
        <Toggle label="Pause sync on this Mac" checked={view.paused} onChange={onPause} />
      </div>
      <div className="settings__row">
        <span className="settings__row-text">
          <span className="settings__row-label">Run automations on this Mac</span>
          <span className="settings__status" data-testid="automations-mac">
            {view.automationsHere
              ? `${view.thisMac} runs them. To move them, turn this on on the other Mac.`
              : `${holder} runs them, so two Macs never run the same rule.`}
          </span>
        </span>
        <Toggle
          label="Run automations on this Mac"
          checked={view.automationsHere}
          disabled={view.automationsHere || view.claiming}
          onChange={onClaimAutomations}
        />
      </div>
    </>
  );
}
