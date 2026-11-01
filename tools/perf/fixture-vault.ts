/*
 * A vault the size of James's, made up from nothing (#217): the fixture the
 * performance harness measures on, so a number taken today can be taken again
 * next month on the same notes.
 *
 * Every name in it is invented — the repository is public — and every note is
 * the same from one run to the next: the only randomness is a seeded generator.
 */

/** One file of the vault, by its path inside it. */
export interface FixtureFile {
  readonly path: string;
  readonly contents: string;
}

/** How many of each kind of note the vault holds. */
export interface FixtureShape {
  readonly areas: number;
  readonly projects: number;
  readonly people: number;
  readonly tasks: number;
  readonly meetings: number;
  readonly notes: number;
  /** Notes waiting in the `Inbox` folder to be filed: what #217 was reported on. */
  readonly inbox: number;
}

/** 2,000 notes, shaped like the vault #217 was reported from: 637 of them in the Inbox. */
export const FIXTURE_SHAPE: FixtureShape = {
  areas: 12,
  projects: 48,
  people: 140,
  tasks: 420,
  meetings: 300,
  notes: 443,
  inbox: 637,
};

/** How many notes a shape makes, not counting the types. */
export const noteCount = (shape: FixtureShape): number =>
  shape.areas +
  shape.projects +
  shape.people +
  shape.tasks +
  shape.meetings +
  shape.notes +
  shape.inbox;

const FIRST = [
  'Mara',
  'Tobias',
  'Ines',
  'Odile',
  'Caspian',
  'Wren',
  'Halden',
  'Liesel',
  'Quentin',
  'Sabine',
  'Rook',
  'Pell',
  'Junia',
  'Ansel',
  'Briar',
  'Corin',
];
const LAST = [
  'Quill',
  'Fenn',
  'Ashgrove',
  'Marlow',
  'Thistle',
  'Vane',
  'Larch',
  'Corbel',
  'Hollis',
  'Pryde',
  'Starling',
  'Dunmore',
];
const WORDS = [
  'Larkspur',
  'harbour',
  'ledger',
  'lantern',
  'meadow',
  'quarry',
  'beacon',
  'orchard',
  'compass',
  'saltmarsh',
  'kiln',
  'tidewater',
  'granary',
  'foundry',
  'heron',
  'juniper',
];
const AREA_NAMES = [
  'Health',
  'Home',
  'Finance',
  'Team',
  'Hiring',
  'Garden',
  'Writing',
  'Travel',
  'Learning',
  'Family',
  'Community',
  'Tools',
];
const GTD = ['inbox', 'backlog', 'next-action', 'in-progress', 'waiting', 'someday', 'archive'];

/** A small seeded generator (mulberry32), so the vault is the same on every run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Draw {
  pick<T>(from: readonly T[]): T;
  words(count: number): string;
}

function drawFrom(random: () => number): Draw {
  const pick = <T>(from: readonly T[]): T => from[Math.floor(random() * from.length)] as T;
  return {
    pick,
    words: (count) => Array.from({ length: count }, () => pick(WORDS)).join(' '),
  };
}

const note = (frontmatter: readonly string[], body: string): string =>
  frontmatter.length === 0 ? `${body}\n` : ['---', ...frontmatter, '---', '', body, ''].join('\n');

const link = (path: string): string => `"[[${path.replace(/\.md$/, '')}]]"`;

const capitalised = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** A paragraph of prose with a few wiki links in it, as notes in a working vault have. */
function prose(draw: Draw, linkable: readonly string[]): string {
  const sentences = Array.from({ length: 4 }, () => `${capitalised(draw.words(9))}.`);
  const links = Array.from({ length: 2 }, () => `[[${draw.pick(linkable).replace(/\.md$/, '')}]]`);
  return `${sentences.join(' ')} See ${links.join(' and ')}.\n\n- ${draw.words(5)}\n- ${draw.words(6)}`;
}

/*
 * No `project` relation on the types below, though PARA files a note by one: it
 * was written `targets:`, which no type file reads, so the app has always left it
 * out — and since #683 says so under Types. The counts are of the vault as the app
 * read it; the relation, written `target:`, costs the 420-row table 120 renders,
 * which is a budget for James to agree.
 */

const TYPES: readonly FixtureFile[] = [
  {
    path: '.atlas/types/task.md',
    contents: note(
      [
        'name: task',
        'label: Task',
        'properties:',
        '  status:',
        '    kind: select',
        '    options: [inbox, backlog, next-action, in-progress, waiting, someday, longterm, archive]',
        '    done: archive',
        '  waiting_on:',
        '    kind: relation',
        '    target: person',
        '  defer: date',
        '  due: date',
        '  completed: date',
      ].flat(),
      '# Task',
    ),
  },
  {
    path: '.atlas/types/project.md',
    contents: note(
      [
        'name: project',
        'label: Project',
        'properties:',
        '  status:',
        '    kind: select',
        '    options: [planned, active, paused, done]',
        '    done: done',
        '  area:',
        '    kind: relation',
        '    target: area',
      ],
      '# Project',
    ),
  },
  {
    path: '.atlas/types/area.md',
    contents: note(['name: area', 'label: Area'], '# Area'),
  },
  {
    path: '.atlas/types/resource.md',
    contents: note(['name: resource', 'label: Resource'], '# Resource'),
  },
  {
    path: '.atlas/types/person.md',
    contents: note(['name: person', 'label: Person', 'properties:', '  role: text'], '# Person'),
  },
  {
    path: '.atlas/types/meeting.md',
    contents: note(
      [
        'name: meeting',
        'label: Meeting',
        'properties:',
        '  date: date',
        '  people:',
        '    kind: relation',
        '    target: person',
        '    many: true',
      ],
      '# Meeting',
    ),
  },
];

/** Names numbered past the lists' length, so every note is its own. */
const numbered = (name: string, index: number, size: number): string =>
  index < size ? name : `${name} ${Math.floor(index / size) + 1}`;

function areas(shape: FixtureShape): FixtureFile[] {
  return Array.from({ length: shape.areas }, (_, index) => ({
    path: `Areas/${numbered(AREA_NAMES[index % AREA_NAMES.length] as string, index, AREA_NAMES.length)}.md`,
    contents: note(['type: area'], 'A responsibility kept up over time.'),
  }));
}

function projects(shape: FixtureShape, draw: Draw, areaPaths: readonly string[]): FixtureFile[] {
  return Array.from({ length: shape.projects }, (_, index) => ({
    path: `Projects/${capitalised(draw.words(2))} ${index + 1}.md`,
    contents: note(
      ['type: project', 'status: active', `area: ${link(draw.pick(areaPaths))}`],
      `Getting the ${draw.words(2)} done.`,
    ),
  }));
}

function people(shape: FixtureShape, draw: Draw): FixtureFile[] {
  return Array.from({ length: shape.people }, (_, index) => ({
    path: `People/${draw.pick(FIRST)} ${draw.pick(LAST)} ${index + 1}.md`,
    contents: note(['type: person', 'role: Controller'], 'Works at Larkspur Payroll.'),
  }));
}

function tasks(
  shape: FixtureShape,
  draw: Draw,
  filed: { projects: readonly string[]; people: readonly string[] },
): FixtureFile[] {
  return Array.from({ length: shape.tasks }, (_, index) => {
    const status = draw.pick(GTD);
    const waiting = status === 'waiting' ? [`waiting_on: ${link(draw.pick(filed.people))}`] : [];
    return {
      path: `Tasks/${capitalised(draw.words(3))} ${index + 1}.md`,
      contents: note(
        [
          'type: task',
          `status: ${status}`,
          `project: ${link(draw.pick(filed.projects))}`,
          ...waiting,
        ],
        `${capitalised(draw.words(7))}.`,
      ),
    };
  });
}

function meetings(shape: FixtureShape, draw: Draw, linkable: readonly string[]): FixtureFile[] {
  return Array.from({ length: shape.meetings }, (_, index) => {
    const day = new Date(Date.UTC(2026, 0, 1 + (index % 280))).toISOString().slice(0, 10);
    return {
      path: `Meetings/${day} ${capitalised(draw.words(2))} ${index + 1}.md`,
      contents: note(['type: meeting', `date: ${day}`], prose(draw, linkable)),
    };
  });
}

function plainNotes(shape: FixtureShape, draw: Draw, linkable: readonly string[]): FixtureFile[] {
  return Array.from({ length: shape.notes }, (_, index) => ({
    path: `Notes/${capitalised(draw.words(3))} ${index + 1}.md`,
    contents: note([], `# ${capitalised(draw.words(3))}\n\n${prose(draw, linkable)}`),
  }));
}

/** Waiting in the Inbox: captured lines, clipped pages and meetings, none of them filed yet. */
function inbox(shape: FixtureShape, draw: Draw, linkable: readonly string[]): FixtureFile[] {
  return Array.from({ length: shape.inbox }, (_, index) => ({
    path: `Inbox/${capitalised(draw.words(3))} ${index + 1}.md`,
    contents: note([], prose(draw, linkable)),
  }));
}

/**
 * Every file of the fixture vault, types first. The same seed and shape make
 * the same files, byte for byte.
 */
export function fixtureVault(shape: FixtureShape = FIXTURE_SHAPE, seed = 217): FixtureFile[] {
  const draw = drawFrom(seeded(seed));
  const areaFiles = areas(shape);
  const projectFiles = projects(
    shape,
    draw,
    areaFiles.map((file) => file.path),
  );
  const peopleFiles = people(shape, draw);
  const filed = {
    projects: projectFiles.map((file) => file.path),
    people: peopleFiles.map((file) => file.path),
  };
  const taskFiles = tasks(shape, draw, filed);
  const linkable = [...filed.projects, ...filed.people, ...taskFiles.map((file) => file.path)];
  return [
    ...TYPES,
    ...areaFiles,
    ...projectFiles,
    ...peopleFiles,
    ...taskFiles,
    ...meetings(shape, draw, linkable),
    ...plainNotes(shape, draw, linkable),
    ...inbox(shape, draw, linkable),
  ];
}
