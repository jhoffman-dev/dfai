/**
 * The prompt notes DFAI ships (P29-05, #179): what a ready-made rule's Claude step
 * is asked. A prompt is a note in `.atlas/prompts/`, the person's to edit, so
 * DFAI writes one only where there is none — when a rule that names it is
 * saved — and never over one the person has changed. One that still holds an
 * earlier version's words exactly, untouched, is brought up to date (#226).
 *
 * The rules a prompt gives are words to a model. What an answer may do is
 * held by its output's schema whatever the prompt says.
 */

import { digestOf } from '../sources/merge.ts';
import { createVaultPath, type VaultPath } from '../vault/vault-path.ts';
import { PROMPTS_DIRECTORY } from './claude-step.ts';

export interface BuiltInPrompt {
  readonly path: VaultPath;
  /** The note as written: a heading for whoever opens it, then what Claude is asked. */
  readonly contents: string;
  /** The {@link promptDigest}s of the versions DFAI shipped before this one. */
  readonly earlier: readonly string[];
}

/**
 * What a prompt's words are known by, to tell an untouched earlier version
 * from one the person edited: two digests and the length, so an edit is
 * never taken for DFAI's own words.
 */
export function promptDigest(text: string): string {
  return `${digestOf(`a${text}`)}${digestOf(`b${text}`)}-${text.length}`;
}

/** The prompt of the `meeting-items` output: what to pull out of a meeting, and how sure to be. */
export const MEETING_EXTRACTION_PROMPT = createVaultPath(
  `${PROMPTS_DIRECTORY}/meeting-extraction.md`,
);

const MEETING_EXTRACTION = `# Meeting extraction

Read the meeting's transcript and pull out what somebody now has to do, what was
decided, and what should be chased later. Each item becomes a proposal the
vault's owner accepts or rejects, so leave out anything they would reject. Most
of a meeting is talk, not commitments: a meeting with nothing in it to do gets
an empty list, and that is a good answer.

This note is yours to edit: it is what a rule with \`output: meeting-items\` asks
Claude. DFAI adds who was in the meeting, the provider's own next steps and the
vocabulary as data beside the meeting, and checks every answer itself.

## What to pull out

- **task** — something a person said they will do, or was asked to do and agreed to.
- **waiting** — the same, when it is somebody else's to do and the owner is waiting
  on it. DFAI decides "mine" or "waiting for" from the owner you name, so name
  the owner with care. Write "asked_by_owner": true only when the owner asked
  that person for it in the meeting.
- **decision** — something the meeting settled in a turn of agreement: a choice
  made, not a topic discussed.
- **follow-up** — something the owner said they will chase or check later.

## Rules

1. **Only real commitments.** Someone must have said they will do it, or agreed
   when asked. An idea, a wish, a "we should", a "maybe", a question nobody
   took on, a description of work already done or under way, a plan recounted
   from somewhere else, or small talk is not an item. When in doubt, leave it out.
2. **Mine and others'.** The vault's owner is written **You** in the transcript,
   or by their name. For what the owner took on, write "owner": "You". For
   anyone else, write their name exactly as the attendee list gives it.
3. **Do not guess a person.** A speaker written Unknown, Remote Speaker or
   Speaker 2 was not named by the provider. If nothing else in the transcript
   makes plain who it is, write "owner": "" and "confidence": "low". If you do
   name someone on the strength of other turns, the confidence is still "low".
4. **Cite one turn.** "source_block" is the id of the single turn where the
   commitment was made or the decision agreed — the turn of the person taking
   it on, or of the agreement, not the question before it. A provider may
   split one sentence over several turns of the same speaker: read them
   together, and cite the one holding the commitment's words.
5. **A decision needs an agreement.** Someone proposes, and the meeting agrees in
   so many words ("Agreed", "Let's go with the Friday release", "Yes, we'll do
   that"). A view, an explanation of how something works, a status update or a
   plan one person describes is not a decision.
6. **The provider's next steps are hints, not a source.** Use them to notice
   what the meeting produced. Keep one only if a turn you were shown says it,
   and cite that turn; otherwise leave it out. Where a hint and the transcript
   disagree about who or what, the transcript wins.
7. **Titles stand alone.** A few words, starting with a verb for a task
   ("Send the renewal contract"), naming what and for whom, so it makes sense
   in a task list without the meeting. Spell names and products as the
   vocabulary does.
8. **A due date only when one was said.** Work it out from the meeting's date
   ("by Friday") and write it as YYYY-MM-DD. If no date or day was said, leave
   "due" out.
9. **Confidence means how sure you are it is real and whose it is.**
   "high": said plainly by a named speaker, and the owner is certain.
   "medium": clear what, some doubt about who or whether it was agreed.
   "low": inferred, or the owner is a guess, or the speaker was not named.
10. **One item per commitment.** No duplicates, and nothing a turn you were shown
    does not say. When you are shown one part of a long transcript, answer for
    that part alone.

## Not items

These are the kinds of things to leave out (the names are made up):

- "I've been reworking the Larkspur Payroll import all week." — work under way, not a new commitment.
- "We should automate that report at some point." — an idea nobody took on.
- "Maybe I'll look at the logs later, if there's time." — a maybe.
- "Could someone check the invoice?" with no one saying they will — a question.
- "I told Tobias last week I'd look into it." — recounted from elsewhere.
- "Our team ships on Tuesdays." — how things work, not a decision.
- "The weather's been awful." — small talk.
`;

/**
 * The prompt of the "After a meeting" rule (#179, ADR-0036): the action items
 * and who owns each. Its rule may make the owner's own into tasks, so the
 * rules about who owns an item are stricter than extraction's; who the owner
 * is, and so what becomes a task, DFAI still decides from the cited turn.
 */
export const AFTER_A_MEETING_PROMPT = createVaultPath(`${PROMPTS_DIRECTORY}/after-a-meeting.md`);

const AFTER_A_MEETING = `# After a meeting

Read the meeting's transcript and list what the vault's owner now has to do,
and what was decided with them. Their own items may be made into tasks without
a click, so list only what they would want on their list: most of a meeting is
talk, and a meeting with nothing for them gets an empty list. Leaving out a
passing remark costs them nothing; listing one costs them time.

This note is yours to edit: it is what the "After a meeting" rule asks Claude.
DFAI adds who was in the meeting, the provider's own next steps and the
vocabulary as data beside the meeting, and checks every answer itself.
DFAI decides who an item belongs to from the turn you cite and the owner you
name, and leaves out other people's items; you never decide what becomes a task.

## What to list

- **task** — something the owner said they will do ("I'll send the contract by
  Friday"), or was asked to do and agreed to ("Can you send it?" — "Yes, I can do that").
- **waiting** — something another person agreed to do because the owner asked
  them for it in the meeting. Write "asked_by_owner": true. Another person's
  own work that the owner did not ask for is not listed at all.
- **decision** — something settled in a turn of agreement that the owner took
  part in: a choice made, not a topic discussed.
- **follow-up** — something the owner said they will chase or check later.

## Who owns an item

1. **Cite the turn of the person who takes it on.** "source_block" is the id of
   the single turn where they said they will do it, or agreed when asked: their
   own words, not the question before them. For a decision, cite the turn of
   the agreement. DFAI reads the owner from that turn's speaker. A provider
   may split one sentence over several turns of the same speaker: read them
   together, and cite the one holding the commitment's words.
2. **Name the owner as the transcript does.** The vault's owner is
   written **You** in the transcript, or by their name: for what they took
   on, write "owner": "You". For anyone else, write their name exactly as the
   attendee list gives it.
3. **One owner per item.** "You and Tobias Fenn", "the team" or two names is not
   an owner: if two people each took a part, list two items, each citing its own
   turn. If it cannot be split, write "owner": "" and "confidence": "low".
4. **"we" is nobody in particular.** "We should send it" or "we'll look at it"
   names no owner unless a later turn says who: write "owner": "" and
   "confidence": "low".
5. **Do not guess a person.** A speaker written Unknown, Remote Speaker or
   Speaker 2 was not named by the provider. If nothing else in the transcript
   makes plain who it is, write "owner": "" and "confidence": "low". If you name
   someone on the strength of other turns, the confidence is still "low".
6. **Confidence means how sure you are it is real and whose it is.**
   "high": the owner's own words commit them plainly, or the meeting agreed a
   decision in so many words. Only "high" may become a task.
   "medium": clearly theirs, but hedged, or the agreement is implied.
   "low": inferred, or the owner is a guess, or the speaker was not named.

## What each item says

7. **Only real commitments.** An idea, a wish, a "we should", a "maybe", a
   question nobody took on, work already done or under way, a plan recounted
   from another conversation, or small talk is not an item. When in doubt,
   leave it out.
8. **A decision needs an agreement.** Someone proposes, and the meeting agrees in
   so many words ("Agreed", "Let's go with the Friday release"). A view, an
   explanation of how something works, a status update, or a plan one person
   describes is not a decision, and nor is a choice other people made about
   their own work while the owner listened.
9. **Titles stand alone.** A few words, starting with a verb for a task ("Send
   the renewal contract"), naming what and for whom, so it makes sense in a task
   list without the meeting. Spell names and products as the vocabulary does.
10. **A due date only when one was said.** Work it out from the meeting's date
    ("by Friday") and write it as YYYY-MM-DD. If no date or day was said, leave
    "due" out.
11. **The provider's next steps are hints, not a source.** Keep one only if a turn
    you were shown says it, and cite that turn. Where a hint and the transcript
    disagree about who or what, the transcript wins.
12. **One item per commitment, and nothing a turn you were shown does not say.**
    When you are shown one part of a long transcript, answer for that part alone.

## Not items

Leave out things like these (the names are made up):

- "I've been reworking the Larkspur Payroll import all week." — work under way.
- "We should automate that report at some point." — an idea nobody took on.
- "Maybe I'll look at the logs later, if there's time." — a maybe.
- "Could someone check the invoice?" with no one saying they will — a question.
- "And I said to Lena, I need to look into it." — recounted from another conversation.
- Mara Quill: "I'll update the release notes." — another person's own work the owner did not ask for.
- "Our team ships on Tuesdays." — how things work, not a decision.
- Two colleagues agree how they will split their own tickets — a decision the owner took no part in.
- "The weather's been awful." — small talk.
`;

/**
 * The prompt of the "Friday review" rule (#40): a draft of the weekly review
 * from the data DFAI hands it. Whatever it says, an item that links no note
 * it was given is left out (`cited-items.ts`).
 */
export const FRIDAY_REVIEW_PROMPT = createVaultPath(`${PROMPTS_DIRECTORY}/friday-review.md`);

const FRIDAY_REVIEW = `# Friday review

Draft this week's review for the vault's owner to read on Friday afternoon:
what got done, what is stuck, and what to decide. Keep it short and plain.

This note is yours to edit: it is what the "Friday review" rule asks Claude.
DFAI hands Claude the weekly review as data — the week's finished tasks and
meetings, who has not come back, overdue tasks, projects with no next action,
someday items left alone, and the Inbox's count — and checks every answer
itself: a list item that does not link its task, project or meeting is left out.

## What the draft holds

- **Wins** — what got done: the finished tasks, and meetings where something
  was settled.
- **Open loops** — overdue tasks, and someday items worth a decision.
- **Waiting for** — who has not come back, and whether to chase them.
- **Projects with no next action** — each needs a next action, or to be put on hold.
- **To decide** — at most five questions for the owner, each linking what it is about.
- One closing sentence on the Inbox: how many notes to file and proposals to answer.

## Rules

1. Every list item links the task, project or meeting it is about by its path,
   exactly as the data writes it: [[Tasks/Send the file.md]].
2. Only what the data says. Do not invent a task, a date or a person.
3. A section with nothing in it says "Nothing this week." as a sentence, not a list item.
4. Title the note "Weekly review" and today's date, written YYYY-MM-DD.
`;

/**
 * The prompt of the "Morning brief" rule (#39): a pre-read for one of today's
 * meetings, from what `brief()` says of the people and companies met. An item
 * that links no note it was given is left out (`cited-items.ts`).
 */
export const MORNING_BRIEF_PROMPT = createVaultPath(`${PROMPTS_DIRECTORY}/morning-brief.md`);

const MORNING_BRIEF = `# Morning brief

Write a short pre-read for one of today's meetings, for the vault's owner to
read before it starts: who they are meeting, where things stand, and what to
bring up. Keep it to what fits on one screen.

This note is yours to edit: it is what the "Morning brief" rule asks Claude,
once for each of today's meetings with a linked person or company. DFAI hands
Claude the meeting and, for each person and company in it, what their page
says — open tasks, who waits on whom, follow-ups, the last meeting and what
came of it, decisions and recent mentions — and checks every answer itself:
a list item that does not link its note is left out.

## What the brief holds

- **Who** — each person and company met, and when they were last met.
- **Where things stand** — open tasks, waiting-fors and follow-ups worth
  raising, overdue ones first.
- **Last time** — what the last meeting settled and what came of it.
- **To bring up** — at most five points for this meeting, each linking what
  it is about.

## Rules

1. Every list item links the note it is about by its path, exactly as the
   data writes it: [[Tasks/Send the file.md]].
2. Only what the data says. Do not invent a task, a date or a person.
3. A section with nothing in it is left out.
4. Title the note after the meeting.
`;

export const BUILT_IN_PROMPTS: readonly BuiltInPrompt[] = [
  {
    path: MEETING_EXTRACTION_PROMPT,
    contents: MEETING_EXTRACTION,
    // P29-05's, then the one that still called the app Atlas (#482).
    earlier: ['8d498b991dc81d80-3232', '232a1cff0581db08-4461'],
  },
  {
    path: AFTER_A_MEETING_PROMPT,
    contents: AFTER_A_MEETING,
    // #179's, then the one that still called the app Atlas (#482).
    earlier: ['6e894bcafa0d09b9-3665', '4be4543b9c77ec18-5365'],
  },
  { path: FRIDAY_REVIEW_PROMPT, contents: FRIDAY_REVIEW, earlier: [] },
  { path: MORNING_BRIEF_PROMPT, contents: MORNING_BRIEF, earlier: [] },
];

/** The prompt DFAI ships at `path`, or null when it ships none there. */
export function builtInPromptAt(path: string): BuiltInPrompt | null {
  return BUILT_IN_PROMPTS.find((prompt) => prompt.path === path) ?? null;
}

/**
 * The prompt DFAI now ships at `path`, when the note there holds the words
 * of an earlier one exactly — never edited, so DFAI's to bring up to date;
 * null for any other note, which is the person's.
 */
export function outdatedBuiltInPrompt(path: string, text: string): BuiltInPrompt | null {
  const prompt = builtInPromptAt(path);
  if (prompt === null || !prompt.earlier.includes(promptDigest(text))) return null;
  return prompt;
}
