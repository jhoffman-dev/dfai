import type { WikiLinkOrEmbed } from './wikilink.ts';

/**
 * The wiki link's grammar, one character at a time.
 *
 * `[[target#heading|alias]]`, with a `!` before it for an embed. The target
 * holds no `[ ] | #`, the heading no `[ ] |`, the alias no `[ ]`; a link does
 * not run over a line break, and `[[]]` links nowhere. `\|` is the alias's
 * pipe, as a table cell must write it. Everything else inside the brackets is
 * the name as written, backslashes and all.
 *
 * Code and a link meet as CommonMark's code spans and brackets do: a code
 * span wholly inside the link is part of its name (`[[x `y` z]]` links to
 * `x `y` z`), but one that would cross the link's edge wins, and there is no
 * link. One opened before the link is the caller's to find; one opened in it
 * — by a backtick run not escaped — whose closing run could only come after
 * it is handed back in `openers`, for the caller to look for further on.
 *
 * Every reader of a note should drive this — the editor code by code, and
 * `wikiLinkSpans` over the raw text
 * for the index, a rename, tags and plain text. Being one reader, they cannot
 * disagree about what is inside a link.
 */
export type ReadStep = 'more' | 'reject' | 'accept';

type Part = 'target' | 'heading' | 'alias';

const BACKTICK = '`';
const ASCII_PUNCTUATION = /^[!-/:-@[-`{-~]$/;

export class WikiLinkReader {
  private state: 'start' | 'bang' | 'open' | 'inside' | 'close' | 'done' = 'start';
  private part: Part = 'target';
  private embed = false;
  private readonly text: Record<Part, string> = { target: '', heading: '', alias: '' };
  private headed = false;
  private aliased = false;
  /** The previous character was a backslash that escapes the next one. */
  private escaping = false;
  private run = 0;
  private runEscaped = false;
  /** The length of the code span open in the link, if one is: only a run as long closes it. */
  private openCode: number | null = null;
  private consumed = 0;
  private targetEnd = -1;

  /**
   * Reads the next character: `null` is the end of the text. `more` asks for
   * another; `reject` means no link starts here; `accept` means the last
   * character read was the link's final `]`.
   */
  read(char: string | null): ReadStep {
    const step = this.step(char);
    if (step !== 'reject') this.consumed += 1;
    return step;
  }

  /** The link read, once `read` has accepted it. */
  get link(): WikiLinkOrEmbed {
    return {
      target: this.text.target,
      heading: this.headed ? this.text.heading : null,
      alias: this.aliased ? this.text.alias.replace(/\\\|/g, '|') : null,
      embed: this.embed,
    };
  }

  /** Where the target ends, counted from the first character read. */
  get targetLength(): number {
    return this.targetEnd;
  }

  /**
   * The length of the code span the link leaves open, if any: a run as long
   * after it in the paragraph closes it over the link's edge, and means no link.
   */
  get openers(): readonly number[] {
    return this.openCode === null ? [] : [this.openCode];
  }

  private step(char: string | null): ReadStep {
    switch (this.state) {
      case 'start':
        if (char === '!') {
          this.embed = true;
          this.state = 'bang';
          return 'more';
        }
        return this.bracket(char, 'open');
      case 'bang':
        return this.bracket(char, 'open');
      case 'open':
        return this.bracket(char, 'inside');
      case 'inside':
        return this.inside(char);
      case 'close':
        if (char !== ']') return 'reject';
        this.state = 'done';
        return 'accept';
      case 'done':
        return 'reject';
    }
  }

  private bracket(char: string | null, next: 'open' | 'inside'): ReadStep {
    if (char !== '[') return 'reject';
    this.state = next;
    return 'more';
  }

  private inside(char: string | null): ReadStep {
    if (char === null || char === '\n' || char === '\r' || char === '[') return 'reject';
    if (char === BACKTICK) {
      if (this.run === 0) this.runEscaped = this.escaping;
      this.run += 1;
      this.escaping = false;
      this.text[this.part] += char;
      return 'more';
    }
    if (this.run > 0) this.endRun();
    const escaped = this.escaping;
    this.escaping = char === '\\' && !escaped;
    if (char === ']') return this.closing();
    if (char === '|' && this.part !== 'alias') {
      if (escaped) this.text[this.part] = this.text[this.part].slice(0, -1);
      this.endTarget(escaped ? 1 : 0);
      this.part = 'alias';
      this.aliased = true;
      return 'more';
    }
    if (char === '#' && this.part === 'target') {
      this.endTarget(0);
      this.part = 'heading';
      this.headed = true;
    }
    this.text[this.part] += char;
    return 'more';
  }

  private closing(): ReadStep {
    this.endTarget(0);
    // `[[]]` links nowhere, and is left as the text it is.
    if (this.text.target.trim() === '' && !this.headed) return 'reject';
    this.state = 'close';
    return 'more';
  }

  /** Marks the target's end at the character being read, less `back` characters. */
  private endTarget(back: number): void {
    if (this.targetEnd < 0) this.targetEnd = this.consumed - back;
  }

  /**
   * Ends a backtick run: it closes the code span open in the link if it is as
   * long, is that span's content if not, and otherwise may open one. An
   * escaped backtick opens nothing; the rest of its run still may.
   */
  private endRun(): void {
    const length = this.run;
    this.run = 0;
    if (this.openCode !== null) {
      if (length === this.openCode) this.openCode = null;
      return;
    }
    const opens = length - (this.runEscaped ? 1 : 0);
    if (opens > 0) this.openCode = opens;
  }
}

/** Whether a backslash before `char` escapes it, as CommonMark reads one. */
export const escapable = (char: string | undefined): boolean =>
  char !== undefined && ASCII_PUNCTUATION.test(char);
