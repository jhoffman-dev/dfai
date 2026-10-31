import { useCallback } from 'react';
import type { VaultPath } from '@dfai/domain';
import {
  embedImage,
  ImageRefusedError,
  type ActivityLog,
  type ImageProbePort,
  type VaultFsPort,
} from '@dfai/application';
import type { EmbedImage } from '@dfai/ui';
import { withGiveUpRecorded } from '../activity/with-give-up-recorded.ts';
import type { ImagePlacementStore } from './browser-image-placement-store.ts';

/** What saving an image into the vault needs from the app around it. */
export interface EmbedImagePorts {
  readonly fs: VaultFsPort;
  readonly probe: ImageProbePort;
  readonly placement: ImagePlacementStore;
  /** Local time, `YYYY-MM-DDTHH:mm:ss`. */
  readonly now: () => string;
  /** Told once an image is written, so the tree and the index see the new file. */
  readonly onSaved: () => void;
  /** Where an image that could not be saved is recorded; the editor shows it where it would have gone. */
  readonly activity: Pick<ActivityLog, 'inOpenVault'>;
}

/**
 * Saves images pasted, dropped or picked into the note at `notePath`, as the
 * editor asks. Undefined when there is no note to put one in.
 */
export function useEmbedImage({
  ports,
  notePath,
}: {
  ports: EmbedImagePorts;
  notePath: VaultPath | null;
}): EmbedImage | undefined {
  const { fs, probe, placement, now, onSaved, activity } = ports;
  const embed = useCallback<EmbedImage>(
    async (file, origin) => {
      if (notePath === null) throw new Error('There is no note to put the image in.');
      const named = {
        activity,
        write: 'image',
        path: notePath,
        refusal: ImageRefusedError,
      } as const;
      const saved = await withGiveUpRecorded(named, () =>
        embedImage({
          fs,
          probe,
          notePath,
          image: { name: file.name, mimeType: file.type, size: file.size, origin },
          readBytes: async () => new Uint8Array(await file.arrayBuffer()),
          placement: placement.read(),
          now: now(),
        }),
      );
      onSaved();
      return { src: saved.src, alt: saved.alt };
    },
    [fs, probe, placement, now, onSaved, activity, notePath],
  );
  return notePath === null ? undefined : embed;
}
