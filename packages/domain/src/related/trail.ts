/**
 * A trail (P32-03): a line of thought walked across notes, one step at a
 * time, by their links and the notes related to them — kept as a browser
 * keeps Back and Forward, and saved as an ordinary note of links.
 */

/** The notes stepped through, oldest first, and which of them the walk is on. */
export interface Trail {
  readonly steps: readonly string[];
  /** The index in `steps` of the note the walk is on. */
  readonly at: number;
}

/** A trail that starts, and stands, at `path`. */
export function startTrail(path: string): Trail {
  return { steps: [path], at: 0 };
}

/** The note the walk is on. */
export function trailStep(trail: Trail): string {
  return trail.steps[trail.at] as string;
}

/**
 * The trail with one more step, to `path`; the note the walk is on is just
 * stood on. From an earlier step it branches: the steps after this one are
 * dropped and the new one follows it, as a browser drops Forward when a new
 * page is opened from an old one — so stepping to the next step already
 * walked keeps the trail as it was, only standing one further on.
 */
export function stepTo(trail: Trail, path: string): Trail {
  if (trailStep(trail) === path) return trail;
  return { steps: [...trail.steps.slice(0, trail.at + 1), path], at: trail.at + 1 };
}

export function canStepBack(trail: Trail): boolean {
  return trail.at > 0;
}

export function canStepForward(trail: Trail): boolean {
  return trail.at < trail.steps.length - 1;
}

/** One step back along the trail; the first step stays where it is. */
export function stepBack(trail: Trail): Trail {
  return canStepBack(trail) ? { ...trail, at: trail.at - 1 } : trail;
}

/** One step forward along steps already walked; the last stays where it is. */
export function stepForward(trail: Trail): Trail {
  return canStepForward(trail) ? { ...trail, at: trail.at + 1 } : trail;
}

/** Stands on the step at `index`, keeping every step; an index outside the trail changes nothing. */
export function standOn(trail: Trail, index: number): Trail {
  return Number.isInteger(index) && index >= 0 && index < trail.steps.length
    ? { ...trail, at: index }
    : trail;
}

/** What a saved trail is named: after the note it starts from. */
export function trailNoteName(startTitle: string): string {
  return `Trail from ${startTitle}`;
}

/**
 * A saved trail's text: a numbered list with one `[[link]]` a line, in the
 * order walked. Plain markdown — any editor reads it as a path in order, each
 * step is its own line to reorder or annotate, the graph and backlinks pick
 * up every step as a link, and a diff of it in git reads line by line.
 * `targets` are what goes inside each `[[…]]`.
 */
export function trailMarkdown(targets: readonly string[]): string {
  return targets.map((target, at) => `${at + 1}. [[${target}]]\n`).join('');
}
