/*
 * Assembles the DFAI Field Guide (docs/guide/index.html) from its sources, so a
 * feature adds a section file rather than editing the one page every feature
 * edits (#134). The page frame lists the sections in order, one marker line
 * each; the contents list is drawn from the same order, so it cannot drift.
 */

/** The page frame and each section's file text, by section id. */
export interface GuideSources {
  readonly page: string;
  readonly sections: ReadonlyMap<string, string>;
}

const CONTENTS_MARKER = '<!-- guide:contents -->';
const SECTION_MARKER = /^<!-- guide:section ([a-z0-9-]+) -->$/;
/** A section file's first line: its label in the contents list. */
const CONTENTS_LABEL = /^<!-- contents: (.+) -->\n/;

interface Section {
  readonly id: string;
  readonly label: string;
  readonly body: string;
}

function parseSection(id: string, text: string): Section {
  const label = CONTENTS_LABEL.exec(text);
  if (!label) throw new Error(`guide section ${id}: first line must be <!-- contents: … -->`);
  const body = text.slice(label[0].length);
  if (!body.startsWith(`    <section id="${id}">`)) {
    throw new Error(`guide section ${id}: must open with <section id="${id}">`);
  }
  if (!body.endsWith('</section>\n')) {
    throw new Error(`guide section ${id}: must end with </section> and a newline`);
  }
  return { id, label: label[1] ?? '', body: body.slice(0, -1) };
}

function sectionsInOrder(frame: readonly string[], sources: GuideSources): Section[] {
  const ids = frame.flatMap((line) => SECTION_MARKER.exec(line)?.[1] ?? []);
  const seen = new Set<string>();
  const sections = ids.map((id) => {
    if (seen.has(id)) throw new Error(`guide section ${id} is listed twice`);
    seen.add(id);
    const text = sources.sections.get(id);
    if (text === undefined) throw new Error(`guide section ${id} is listed but has no file`);
    return parseSection(id, text);
  });
  const unlisted = [...sources.sections.keys()].filter((id) => !seen.has(id));
  if (unlisted.length > 0) {
    throw new Error(`guide sections not listed in the page: ${unlisted.join(', ')}`);
  }
  return sections;
}

/** The published page: the frame with its contents list and sections filled in. */
export function assembleGuide(sources: GuideSources): string {
  const frame = sources.page.split('\n');
  if (frame.filter((line) => line === CONTENTS_MARKER).length !== 1) {
    throw new Error(`the guide page must hold ${CONTENTS_MARKER} once`);
  }
  const byId = new Map(sectionsInOrder(frame, sources).map((section) => [section.id, section]));
  const out: string[] = [];
  let afterSection = false;
  for (const line of frame) {
    const id = SECTION_MARKER.exec(line)?.[1];
    const section = id === undefined ? undefined : byId.get(id);
    if (section) {
      // Sections sit one blank line apart.
      if (afterSection) out.push('');
      out.push(section.body);
    } else if (line === CONTENTS_MARKER) {
      out.push(...[...byId.values()].map((s) => `    <a href="#${s.id}">${s.label}</a>`));
    } else {
      out.push(line);
    }
    afterSection = section !== undefined;
  }
  return out.join('\n');
}
