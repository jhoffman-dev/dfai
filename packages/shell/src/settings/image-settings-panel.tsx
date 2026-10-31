import { memo, useState } from 'react';
import { ImageSettings } from '@dfai/ui';
import type { ImagePlacementStore } from '../notes/browser-image-placement-store.ts';

/**
 * Settings → Images, wired to where the choice is kept. Its store is one for the
 * whole app, so the window drawing again does not draw it again (#508 perf).
 */
export const ImageSettingsPanel = memo(function ImageSettingsPanel({
  store,
}: {
  store: ImagePlacementStore;
}) {
  const [placement, setPlacement] = useState(() => store.read());
  return (
    <ImageSettings
      placement={placement}
      onChange={(chosen) => {
        store.write(chosen);
        setPlacement(chosen);
      }}
    />
  );
});
