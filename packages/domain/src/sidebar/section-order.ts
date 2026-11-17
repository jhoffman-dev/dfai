import { isSidebarSectionId, SIDEBAR_SECTIONS, type SidebarSectionId } from './sidebar-section.ts';

/** The settings key that lists the sidebar's sections in the order chosen for them. */
export const SIDEBAR_ORDER_KEY = 'sidebarOrder';

const DEFAULT_ORDER: readonly SidebarSectionId[] = SIDEBAR_SECTIONS.map((section) => section.id);

/**
 * The section order a vault's settings hold, or null when the key is not there.
 *
 * A hand-edited file can hold anything: a lone name is read as a list of one,
 * an id that names no section (one since removed, or a typo) is ignored, and a
 * repeat counts once.
 */
export function parseSectionOrder(value: unknown): readonly SidebarSectionId[] | null {
  if (value === undefined || value === null) return null;
  const listed: unknown[] = Array.isArray(value) ? value : [value];
  return [...new Set(listed.filter(isSidebarSectionId))];
}

/**
 * Every section, in the order chosen for them.
 *
 * The chosen ones first, then any the saved order does not name, in their
 * default order: a section added in a later version turns up at the end rather
 * than not at all.
 */
export function sectionOrder(saved: readonly SidebarSectionId[] | null): SidebarSectionId[] {
  const chosen = [...new Set(saved ?? [])];
  return [...chosen, ...DEFAULT_ORDER.filter((id) => !chosen.includes(id))];
}

interface SectionMove {
  order: readonly SidebarSectionId[];
  id: SidebarSectionId;
  to: number;
}

/**
 * Where a move to place `to` really lands: the place clamped to the list.
 *
 * Whether a section is open or shut has no say in where it sits. Shut
 * sections used to gather below the open ones, but since the sections share
 * one scroller (issue #17) that is below every row of Pages, where a section
 * just shut would vanish (ADR-0013, addendum).
 */
function landing({ order, id, to }: SectionMove) {
  const full = sectionOrder(order);
  return { full, from: full.indexOf(id), place: Math.max(0, Math.min(to, full.length - 1)) };
}

/** Whether moving a section to place `to` changes the order. */
export function canMoveSection(move: SectionMove): boolean {
  const { from, place } = landing(move);
  return place !== from;
}

/**
 * The chosen order after a section is moved to place `to`: just before the
 * section it landed on when it moved up, and just after it when it moved down
 * — exactly where it was dropped.
 */
export function movedSection(move: SectionMove): SidebarSectionId[] {
  const { full, from, place } = landing(move);
  const target = full[place];
  if (target === undefined || place === from) return full;

  const rest = full.filter((section) => section !== move.id);
  const at = rest.indexOf(target) + (place > from ? 1 : 0);
  return [...rest.slice(0, at), move.id, ...rest.slice(at)];
}

/** The sections the sidebar draws: every one in the order chosen, less those hidden (#902). */
export function shownSections({
  order,
  hidden,
}: {
  order: readonly SidebarSectionId[] | null;
  hidden: readonly SidebarSectionId[];
}): SidebarSectionId[] {
  return sectionOrder(order).filter((id) => !hidden.includes(id));
}

/**
 * Where a drop at place `to` among the shown sections lands in the whole
 * order: the place of the shown section it was dropped on. A hidden section
 * keeps its own place, so a move made around it puts the moved one exactly
 * where it was dropped on screen.
 */
export function placeInOrder({
  order,
  shown,
  to,
}: {
  order: readonly SidebarSectionId[] | null;
  shown: readonly SidebarSectionId[];
  to: number;
}): number {
  const target = shown[Math.max(0, Math.min(to, shown.length - 1))];
  return target === undefined ? to : sectionOrder(order).indexOf(target);
}
