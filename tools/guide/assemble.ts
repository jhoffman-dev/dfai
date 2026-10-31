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

/** Openings and closings of a section, however they are cased or spaced. */
const SECTION_OPEN = /<section[\s>]/gi;
const SECTION_CLOSE = /<\/section\s*>/gi;

function parseLabel(id: string, text: string): { label: string; rest: string } {
  const match = CONTENTS_LABEL.exec(text);
  if (!match) throw new Error(`guide section ${id}: first line must be <!-- contents: … -->`);
  const label = match[1] ?? '';
  if (label.trim() === '') throw new Error(`guide section ${id}: its contents label is blank`);
  // The label is written into the contents list as it stands, so it may not carry markup.
  if (/[<>]/.test(label)) throw new Error(`guide section ${id}: its contents label holds < or >`);
  return { label, rest: text.slice(match[0].length) };
}

function parseSection(id: string, text: string): Section {
  const { label, rest: body } = parseLabel(id, text);
  if (!body.startsWith(`    <section id="${id}">`)) {
    throw new Error(`guide section ${id}: must open with <section id="${id}">`);
  }
  if (!body.endsWith('</section>\n')) {
    throw new Error(`guide section ${id}: must end with </section> and a newline`);
  }
  if (body.match(SECTION_OPEN)?.length !== 1) {
    throw new Error(`guide section ${id}: must hold one <section>, not more`);
  }
  // One closing, at the end: anything after it would sit in <main>, outside every section.
  if (body.match(SECTION_CLOSE)?.length !== 1) {
    throw new Error(`guide section ${id}: nothing may follow its </section>`);
  }
  return { id, label, body: body.slice(0, -1) };
}

/** A marker line that is nearly right would be published as a comment, its section left out. */
function refuseLooseMarkers(frame: readonly string[]): void {
  const loose = frame.find((line) => line.includes('guide:section') && !SECTION_MARKER.test(line));
  if (loose !== undefined) {
    throw new Error(`guide page: not a section marker <!-- guide:section <id> -->: ${loose}`);
  }
}

/** Whether a line leaves an HTML comment open: its last `<!--` comes after its last `-->`. */
const opensComment = (line: string) => line.lastIndexOf('<!--') > line.lastIndexOf('-->');

/** A marker inside a comment would fill in a section the browser never shows. */
function refuseMarkersInComments(frame: readonly string[]): void {
  let inComment = false;
  for (const line of frame) {
    if (inComment && line.includes('guide:')) {
      throw new Error(`guide page: a marker inside an HTML comment: ${line}`);
    }
    inComment = inComment ? !line.includes('-->') : opensComment(line);
  }
}

function sectionsInOrder(frame: readonly string[], sources: GuideSources): Section[] {
  refuseLooseMarkers(frame);
  refuseMarkersInComments(frame);
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

const ID = /\sid=["']([^"']+)["']/g;
const IN_PAGE_LINK = /\shref=["']#([^"']*)["']/g;

/**
 * Every id once, and every in-page link to one of them: renaming a section
 * otherwise leaves the links to it from other sections dead without a word.
 */
function refuseBrokenAnchors(page: string): void {
  const ids = new Set<string>();
  for (const [, id = ''] of page.matchAll(ID)) {
    if (ids.has(id)) throw new Error(`guide page: the id "${id}" is used twice`);
    ids.add(id);
  }
  const dead = [...page.matchAll(IN_PAGE_LINK)]
    .map(([, id = '']) => id)
    .filter((id) => !ids.has(id));
  if (dead.length > 0) {
    throw new Error(`guide page: links to ids no element has: ${[...new Set(dead)].join(', ')}`);
  }
}

function fillFrame(frame: readonly string[], byId: ReadonlyMap<string, Section>): string {
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

/** The published page: the frame with its contents list and sections filled in. */
export function assembleGuide(sources: GuideSources): string {
  const frame = sources.page.split('\n');
  if (frame.filter((line) => line === CONTENTS_MARKER).length !== 1) {
    throw new Error(`the guide page must hold ${CONTENTS_MARKER} once`);
  }
  const byId = new Map(sectionsInOrder(frame, sources).map((section) => [section.id, section]));
  const page = fillFrame(frame, byId);
  refuseBrokenAnchors(page);
  return page;
}
