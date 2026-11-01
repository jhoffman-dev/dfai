// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { parseObjectType, type ObjectType } from '@dfai/domain';
import { fakeIndexPort, fakeVaultFs, recordingActivity } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import type { OpenEditors } from '../panes/open-editors.ts';
import { useAtlasQueryPage } from './use-atlas-query-page.ts';

/** Where the hooks under test record what they give up on; these tests do not read it. */
const ACTIVITY = recordingActivity();

const TYPES: readonly ObjectType[] = [parseObjectType({ name: 'task', properties: {} })];
const NOTES: readonly string[] = [];
const NONE = [] as const;
const NO_PANE: OpenEditors = {
  register: () => {},
  setPropertiesIfOpen: async () => false,
  savePane: () => {},
  reloadOthers: () => {},
};
const INDEX = fakeIndexPort({
  query: async () => ({ columns: ['path', 'title', 'type'], rows: [], truncated: false }),
});
const FS = fakeVaultFs();

function page() {
  return renderHook(() =>
    useAtlasQueryPage({
      ports: {
        index: INDEX,
        fs: FS,
        markdown: remarkMarkdown,
        editors: NO_PANE,
        activity: ACTIVITY,
      },
      types: TYPES,
      notePaths: NOTES,
      indexKey: 'ready:1',
      viewPaths: NONE,
      dashboards: NONE,
      onSavedView: () => {},
      onChanged: () => {},
      onOpenNote: () => {},
    }),
  );
}

describe('useAtlasQueryPage', () => {
  it('starts as every note of the first type, in the builder', async () => {
    const view = page();
    await waitFor(() => expect(view.result.current.composer.text).toBe('FROM task'));
    expect(view.result.current.composer.mode).toBe('builder');
  });

  it('lets the text be cleared to write another, rather than putting the start back', async () => {
    const view = page();
    await waitFor(() => expect(view.result.current.composer.text).toBe('FROM task'));
    act(() => view.result.current.composer.onMode('text'));
    act(() => view.result.current.composer.onTextChange(''));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(view.result.current.composer.text).toBe('');
    expect(view.result.current.composer.mode).toBe('text');
  });
});
