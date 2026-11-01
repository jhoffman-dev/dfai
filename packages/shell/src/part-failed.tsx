import type { ComponentProps } from 'react';
import { SettingsUnavailable, type SettingsDialog } from '@dfai/ui';
import type { SidebarChatProps } from './chat/sidebar-chat.tsx';
import type { FailedPartProps } from './on-first-use.ts';
import { PageFrameFallback, type PageChrome } from './page-frame-fallback.tsx';

type Outcome = Omit<FailedPartProps<unknown>, 'props'>;

/**
 * A part whose chunk could not be loaded: a quiet line and the way to try
 * again; once that has failed too, the way to load the window again.
 */
export function PartFailed({ retrying, onRetry, onReloadWindow }: Outcome) {
  return (
    <div className="viewer" role="alert">
      <p>This part couldn’t load.</p>
      {onReloadWindow !== null && (
        <p>Reloading the window starts DFAI again. Unsaved changes might be lost.</p>
      )}
      <button type="button" className="btn btn--sm" disabled={retrying} onClick={onRetry}>
        {retrying ? 'Reloading…' : 'Reload'}
      </button>
      {onReloadWindow !== null && (
        <button type="button" className="btn btn--sm" onClick={onReloadWindow}>
          Reload window
        </button>
      )}
    </div>
  );
}

/** A page whose chunk could not be loaded: the same, inside the page's frame. */
export function PageFailed({ props, ...outcome }: FailedPartProps<PageChrome>) {
  return (
    <PageFrameFallback
      {...(props.onShowSidebar !== undefined && { onShowSidebar: props.onShowSidebar })}
      {...(props.history !== undefined && { history: props.history })}
    >
      <PartFailed {...outcome} />
    </PageFrameFallback>
  );
}

/** Settings whose chunk could not be loaded: the same, inside Settings' window, which closes as ever. */
export function SettingsFailed({
  props,
  ...outcome
}: FailedPartProps<ComponentProps<typeof SettingsDialog>>) {
  return (
    <SettingsUnavailable
      onClose={props.onClose}
      {...(props.fallbackFocus !== undefined && { fallbackFocus: props.fallbackFocus })}
    >
      <PartFailed {...outcome} />
    </SettingsUnavailable>
  );
}

/** Claude's panel whose chunk could not be loaded: the same, in the panel's place, with its Close. */
export function ChatFailed({ props, ...outcome }: FailedPartProps<SidebarChatProps>) {
  return (
    <aside className="chat" aria-label="Claude">
      <PartFailed {...outcome} />
      <button type="button" className="btn btn--sm" onClick={props.actions.onClose}>
        Close
      </button>
    </aside>
  );
}
