import { DEFAULT_IMAGE_PLACEMENT, isImagePlacement, type ImagePlacement } from '@dfai/domain';

const KEY = 'atlas.imagePlacement';

/** Where embedded images go, as Settings → Images chose. */
export interface ImagePlacementStore {
  read(): ImagePlacement;
  write(placement: ImagePlacement): void;
}

/**
 * The choice, kept in `localStorage` like the theme: a preference of this
 * Mac's, not something the vault records.
 *
 * Every access is guarded, since the accessor itself throws wherever site
 * data is blocked. A choice that cannot be read is the default — the
 * attachments folder — which is where an image would have gone anyway.
 */
export const browserImagePlacementStore: ImagePlacementStore = createBrowserImagePlacementStore();

export function createBrowserImagePlacementStore(): ImagePlacementStore {
  // This session's choice, which holds even where storage refuses it.
  let chosen: ImagePlacement | null = null;
  return {
    read: () => chosen ?? readStored(),
    write: (placement) => {
      chosen = placement;
      try {
        window.localStorage.setItem(KEY, placement);
      } catch {
        // Safe to ignore: the choice still applies for this session, and it
        // just will not be there next time.
      }
    },
  };
}

function readStored(): ImagePlacement {
  try {
    const stored = window.localStorage.getItem(KEY);
    return isImagePlacement(stored) ? stored : DEFAULT_IMAGE_PLACEMENT;
  } catch {
    return DEFAULT_IMAGE_PLACEMENT;
  }
}
