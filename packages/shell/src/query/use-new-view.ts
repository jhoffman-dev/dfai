import { useCallback, useMemo, useState } from 'react';
import {
  layoutLabel,
  newViewProblems,
  VIEW_LAYOUTS,
  type NewViewRequest,
  type ObjectType,
  type VaultPath,
} from '@dfai/domain';
import {
  createView,
  ViewRefusedError,
  type ActivityLog,
  type MarkdownPort,
  type VaultFsPort,
} from '@dfai/application';
import { withGiveUpRecorded } from '../activity/with-give-up-recorded.ts';
import { errorMessage } from './error-message.ts';

const BLANK: NewViewRequest = { name: '', type: '', layout: 'table' };

/**
 * The New view dialog's state: what is being asked for, what stops it, and
 * making it. Every layout the domain knows is offered, so one added there
 * appears here without a change.
 */
export function useNewView({
  fs,
  markdown,
  types,
  viewPaths,
  activity,
  onCreated,
}: {
  fs: VaultFsPort;
  markdown: MarkdownPort;
  types: readonly ObjectType[];
  viewPaths: readonly string[];
  /** Where a view that could not be written is recorded. */
  activity: Pick<ActivityLog, 'inOpenVault'>;
  onCreated: (path: VaultPath) => void;
}) {
  const [request, setRequest] = useState<NewViewRequest>(BLANK);
  const [writeError, setWriteError] = useState<string | null>(null);

  const problems = useMemo(
    () => [
      ...newViewProblems(request, { types, takenPaths: viewPaths }),
      ...(writeError === null ? [] : [writeError]),
    ],
    [request, types, viewPaths, writeError],
  );

  /** Opens the dialog fresh, on a type when it was asked for from one. */
  const start = useCallback(
    (type: string | null) => {
      setRequest({ ...BLANK, type: type ?? types[0]?.name ?? '' });
      setWriteError(null);
    },
    [types],
  );

  const change = useCallback((next: NewViewRequest) => {
    setRequest(next);
    setWriteError(null);
  }, []);

  const create = useCallback(() => {
    const named = { activity, write: 'view', path: null, refusal: ViewRefusedError } as const;
    withGiveUpRecorded(named, () =>
      createView({ fs, markdown, request, types, takenPaths: viewPaths }),
    )
      .then(onCreated)
      .catch((cause: unknown) => setWriteError(errorMessage(cause)));
  }, [fs, markdown, request, types, viewPaths, activity, onCreated]);

  const typeChoices = useMemo(
    () => types.map((type) => ({ value: type.name, label: type.label })),
    [types],
  );

  return { request, problems, start, change, create, typeChoices, layoutChoices: LAYOUT_CHOICES };
}

const LAYOUT_CHOICES = VIEW_LAYOUTS.map((layout) => ({
  value: layout,
  label: layoutLabel(layout),
}));
