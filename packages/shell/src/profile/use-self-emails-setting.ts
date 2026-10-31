import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  saveSelfEmails,
  suggestSelfEmails,
  type ActivityLog,
  type IndexPort,
  type MarkdownPort,
  type VaultFsPort,
} from '@dfai/application';
import { parseSelfEmails, selfEmailsFromText, type SelfEmails } from '@dfai/domain';
import type { SelfEmailsView } from '@dfai/ui';
import { useVaultSetting } from '../settings/use-vault-setting.ts';
import { useVaultSettingsRead } from '../settings/use-vault-settings-read.ts';
import { vaultSettingsWriter } from '../settings/vault-settings-writer.ts';

/** Settings → Profile's addresses, and the addresses everything that asks who the owner is reads. */
export interface SelfEmailsSetting {
  /**
   * The owner's addresses in use: those this vault's settings hold, else —
   * while they hold none — those of the owner's own Person note, the ones
   * the card shows (#226). None until they are read, and none while the
   * settings cannot be read, so nothing is guessed meanwhile.
   */
  readonly emails: readonly string[];
  /**
   * Whether this vault's settings note has answered (read, or found
   * unreadable) and, while it holds no address and the index is built, the
   * Person note has too: until then `emails` is a stand-in, and nothing that
   * asks who the owner is should act on it.
   */
  readonly settled: boolean;
  readonly view: SelfEmailsView;
  /**
   * Keeps the addresses typed as `selfEmails`, settling once the write has:
   * true when they were kept; false when what was typed is not all addresses
   * (nothing written) or the write failed — the reason in the view's
   * `problem` either way, and the write's in `problem` too.
   */
  readonly save: (typed: string) => Promise<boolean>;
  /** Why the last save failed, or why the settings note cannot be read. */
  readonly problem: string | null;
}

/** Something said about one vault, kept with the vault it was said of. */
interface Said<T> {
  readonly vault: string;
  readonly value: T;
}

const listed = (emails: readonly string[]) => emails.join(', ');

/** None, as one value: a fresh `[]` each render would change everything that depends on it. */
const NO_EMAILS: readonly string[] = Object.freeze([]);

/**
 * The same list for as long as it holds the same addresses: they are read
 * again on every vault change, and a new array each time would make the
 * owner look changed to everything keyed on them (#231).
 */
function useSameWhileUnchanged(emails: readonly string[]): readonly string[] {
  const spelled = JSON.stringify(emails);
  return useMemo(
    () => (spelled === '[]' ? NO_EMAILS : Object.freeze(JSON.parse(spelled) as string[])),
    [spelled],
  );
}

/** Why the addresses the settings hold could not be read, as the card says it; null when they were. */
function unreadableOf(read: SelfEmails | null): string | null {
  if (read === null || read.problem === null) return null;
  return `Your emails in settings could not be read: ${read.problem}`;
}

/** The Person note's addresses, once looked up for this vault; null until then. */
type PersonNoteEmails = readonly string[] | null;

/**
 * The Person note's addresses for the profile's name: the owner's while the
 * settings hold none (#226), so what the card shows is what DFAI uses. One
 * that cannot be read is said in the console and read as none, so the
 * owner's addresses still settle.
 */
function usePersonNoteEmails({
  fs,
  markdown,
  index,
  vault,
  changeKey,
  indexReady,
}: {
  fs: VaultFsPort;
  markdown: MarkdownPort;
  index: IndexPort;
  vault: string | null;
  changeKey: string;
  indexReady: boolean;
}): PersonNoteEmails {
  const [found, setFound] = useState<Said<readonly string[]> | null>(null);
  const { settings, unreadable } = useVaultSettingsRead({ fs, markdown, vaultKey: vault });
  useEffect(() => {
    // People are read from the index: asked of one still being built, it would be built twice.
    if (vault === null || !indexReady) return;
    if (unreadable !== null) {
      console.error('The Person note’s addresses could not be read:', unreadable);
      setFound({ vault, value: NO_EMAILS });
      return;
    }
    if (settings === undefined) return;
    let live = true;
    suggestSelfEmails({ settings, index }).then(
      (emails) => live && setFound({ vault, value: emails }),
      (cause: unknown) => {
        console.error('The Person note’s addresses could not be read:', cause);
        if (live) setFound({ vault, value: NO_EMAILS });
      },
    );
    return () => {
      live = false;
    };
  }, [settings, unreadable, index, vault, changeKey, indexReady]);
  return found?.vault === vault ? found.value : null;
}

/**
 * The vault owner's own addresses, `selfEmails` in the vault's settings beside
 * the profile's names (ADR-0024 amendment), with Granola's older key read in
 * its place while it holds none, and the owner's Person note's while neither
 * does (#226): no button needs pressing for the addresses shown to count.
 * Once a list is saved, it is the only one. Settings that cannot be read use
 * no address at all: nothing is guessed in their place.
 */
export function useSelfEmailsSetting({
  fs,
  markdown,
  index,
  vaultKey,
  changeKey,
  indexReady = true,
  activity,
}: {
  fs: VaultFsPort;
  markdown: MarkdownPort;
  index: IndexPort;
  vaultKey: string | null;
  changeKey: string;
  /** Whether the index has been built: the Person note is looked up in it only then. */
  indexReady?: boolean;
  /** Where a save that fails is recorded. */
  activity: Pick<ActivityLog, 'inOpenVault'>;
}): SelfEmailsSetting {
  const store = useCallback(
    ({ emails }: SelfEmails) =>
      saveSelfEmails({ settings: vaultSettingsWriter({ fs, markdown }), emails }),
    [fs, markdown],
  );
  const setting = useVaultSetting({
    fs,
    markdown,
    parse: parseSelfEmails,
    store,
    vaultKey,
    activity,
  });
  const personNote = usePersonNoteEmails({
    fs,
    markdown,
    index,
    vault: vaultKey,
    changeKey,
    indexReady,
  });
  const [refused, setRefused] = useState<Said<string> | null>(null);
  const read = setting.loaded ? setting.value : null;
  const kept = read?.source === 'selfEmails' ? read.emails : [];
  const inherited = read?.source === 'granola_self_emails' ? read.emails : [];
  // The Person note's count only while the settings were read and hold none.
  const fromPersonNote =
    read !== null && read.problem === null && read.emails.length === 0 ? personNote : NO_EMAILS;
  const emails = read === null ? NO_EMAILS : read.emails.length > 0 ? read.emails : fromPersonNote;
  const inUse = useSameWhileUnchanged(emails ?? NO_EMAILS);
  return {
    emails: inUse,
    // Before the index is built nothing that reads the owner's addresses runs on it, so it is not waited for.
    settled: setting.answered && (emails !== null || !indexReady),
    view: {
      kept: listed(kept),
      inherited: inherited.length === 0 ? null : listed(inherited),
      suggested:
        fromPersonNote === null || fromPersonNote.length === 0 ? null : listed(fromPersonNote),
      problem: refused !== null && refused.vault === vaultKey ? refused.value : null,
      unreadable: unreadableOf(read),
      disabled: !setting.loaded,
    },
    problem: setting.problem ?? setting.unreadable,
    save: async (typed) => {
      if (vaultKey === null) return false;
      const reading = selfEmailsFromText(typed);
      setRefused(reading.ok ? null : { vault: vaultKey, value: reading.problem });
      if (!reading.ok) return false;
      const source = reading.emails.length === 0 ? null : 'selfEmails';
      const failed = await setting.write({ emails: reading.emails, source, problem: null });
      // The field says why a write failed, under what it keeps of the typing.
      if (failed !== null) setRefused({ vault: vaultKey, value: failed });
      return failed === null;
    },
  };
}
