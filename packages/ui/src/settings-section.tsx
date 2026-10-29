import { useCallback, useState, type ReactNode } from 'react';
import type { SettingsSectionLink } from './settings-section-links.ts';

/**
 * One part of Settings — Connections, Index — as a hairline group under a
 * 15/600 title (UI v2 slice 13f): no card, no icon tile. The heading takes
 * focus when its row in the dialog's list is chosen, so the next Tab lands on
 * the section's first control.
 */
export function SettingsSection({
  section,
  children,
}: {
  /** Names the section for assistive technology, through its heading. */
  section: SettingsSectionLink;
  children: ReactNode;
}) {
  return (
    <section className="settings__section" aria-labelledby={section.id}>
      <h2 className="settings__heading" id={section.id} tabIndex={-1}>
        {section.title}
      </h2>
      {children}
    </section>
  );
}

/**
 * How far ahead of the screen a section's body is drawn: more than the
 * section above it is tall, so that Tab from its last control lands in this
 * one's first, rather than past it into the next section (review of PR #631).
 */
const DRAWN_BEFORE_REACHED = '400px 0px';

/** The nearest element `element` scrolls in, or null for the window. */
function scrollerOf(element: HTMLElement): HTMLElement | null {
  for (let at = element.parentElement; at !== null; at = at.parentElement) {
    const { overflowY } = getComputedStyle(at);
    if (overflowY === 'auto' || overflowY === 'scroll') return at;
  }
  return null;
}

/**
 * A part of Settings whose body is drawn only once it is shown — scrolled
 * into view, or chosen in the dialog's list, which scrolls to it. Until then
 * it is its heading alone, so a section that asks the host or a service
 * about itself asks nothing, and draws nothing, for a Settings opened to
 * change something else (#105: "Open Settings" is held to a work budget).
 * Once shown it stays drawn for as long as Settings is open.
 */
export function SettingsSectionWhenShown({
  section,
  children,
}: {
  section: SettingsSectionLink;
  children: ReactNode;
}) {
  const [shown, setShown] = useState(false);
  const watch = useCallback((element: HTMLElement | null) => {
    if (element === null) return;
    if (typeof IntersectionObserver === 'undefined') {
      // No way to tell what is on screen: draw it, as any other section is.
      setShown(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        setShown(true);
      },
      // The margin reaches past the screen only when measured against the
      // pane the sections scroll in: against the window, the pane clips it.
      { root: scrollerOf(element), rootMargin: DRAWN_BEFORE_REACHED },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <section
      className="settings__section"
      aria-labelledby={section.id}
      ref={shown ? undefined : watch}
    >
      <h2 className="settings__heading" id={section.id} tabIndex={-1}>
        {section.title}
      </h2>
      {shown ? children : null}
    </section>
  );
}
