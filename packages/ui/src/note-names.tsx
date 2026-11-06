import { createContext, useContext } from 'react';
import {
  noteNames,
  type LinkedName,
  type NoteNames,
  type PillHue,
  type VaultPath,
} from '@dfai/domain';

/**
 * The vault's notes by name, which every place that shows a relation reads
 * its links against. Until the app provides them, links read as their bare
 * names and none is called missing.
 */
const NoteNamesContext = createContext<NoteNames>(noteNames(null));

export const NoteNamesProvider = NoteNamesContext.Provider;

export function useNoteNames(): NoteNames {
  return useContext(NoteNamesContext);
}

/**
 * One linked note, by name: a button that opens it when there is a note to
 * open, otherwise its bare name, struck through when nothing answers to it.
 * A note that is there carries its path as `data-link-path`, which is how a
 * relation value is found for its preview card (`useLinkHover`).
 */
export function LinkedNote({
  name,
  className,
  hue,
  onOpen,
  hint,
}: {
  name: LinkedName;
  className: string;
  /** The chip's pastel (`relationHue`); a link to nothing keeps the muted strike instead. */
  hue?: PillHue;
  /** Left out where the note cannot be opened from here. */
  onOpen?: (path: VaultPath) => void;
  /** Shows the whole name on hover where the chip may cut it short. */
  hint?: boolean;
}) {
  const { path } = name;
  const tint = hue === undefined || name.missing ? {} : { 'data-hue': hue };
  const hover = hint === true ? { title: name.text } : {};
  if (path !== null && onOpen !== undefined) {
    return (
      <button
        type="button"
        className={className}
        data-link-path={path}
        {...tint}
        {...hover}
        aria-label={`Open ${name.text}`}
        onClick={(event) => {
          // A link inside something clickable opens its note, not the thing.
          event.stopPropagation();
          onOpen(path);
        }}
      >
        {name.text}
      </button>
    );
  }
  return (
    <span
      className={className}
      data-missing={name.missing}
      {...(path !== null && { 'data-link-path': path })}
      {...tint}
      {...hover}
    >
      {name.text}
    </span>
  );
}
