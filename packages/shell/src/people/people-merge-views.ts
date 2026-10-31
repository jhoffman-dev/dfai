import {
  noteTitle,
  parentVaultPath,
  VAULT_ROOT,
  type DuplicatePair,
  type DuplicateReason,
  type VaultPath,
} from '@dfai/domain';
import type { PeopleMergePreview } from '@dfai/application';
import type {
  DuplicatePairView,
  DuplicateReasonView,
  MergePersonChoice,
  MergePreviewView,
} from '@dfai/ui';

/** A person as a picker or the list names them: their title, and the folder they are in. */
export function personChoice(path: VaultPath): MergePersonChoice {
  const folder = parentVaultPath(path);
  return { path, name: noteTitle(path), place: folder === VAULT_ROOT ? '' : folder };
}

/** A value as the merge question shows it: text as written, a list joined, anything else as JSON. */
function shownValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(shownValue).join(', ');
  return JSON.stringify(value) ?? '';
}

/** What a worked-out merge does, in the words the question shows. */
export function mergePreviewView(preview: PeopleMergePreview): MergePreviewView {
  const plan = preview.plan;
  return {
    keep: noteTitle(preview.keep),
    merge: preview.merge.map(noteTitle),
    notes: preview.writes.filter((write) => write.path !== preview.keep && write.links > 0).length,
    links: preview.links,
    conflicts: (plan?.conflicts ?? []).map((conflict) => ({
      key: conflict.key,
      kept: shownValue(conflict.kept),
      other: shownValue(conflict.other),
      from: noteTitle(conflict.from),
    })),
    aliasesAdded: plan?.aliasesAdded ?? [],
    emailsAdded: plan?.emailsAdded ?? [],
    bodies: plan?.appended.length ?? 0,
  };
}

const LOCAL_WORDS = {
  same: 'Same email, written differently',
  'first-name': 'First name and full name',
  typo: 'Email a typo apart',
} as const;

/** Why two people may be one, as its chip says it — each kind in a hue of its own, so the eye finds it again. */
export function duplicateReasonView(reason: DuplicateReason): DuplicateReasonView {
  switch (reason.kind) {
    case 'same-email':
      return { text: 'Same email', hue: 'green', detail: reason.email };
    case 'same-name':
      return { text: 'Same name', hue: 'blue' };
    case 'alias':
      return { text: 'Alias', hue: 'purple', detail: reason.alias };
    case 'similar-email': {
      const domain = reason.sameDomain ? '' : ', near domain';
      return {
        text: `${LOCAL_WORDS[reason.local]}${domain}`,
        hue: reason.local === 'typo' ? 'orange' : 'yellow',
        detail: `${reason.left} · ${reason.right}`,
      };
    }
  }
}

export function duplicatePairView(pair: DuplicatePair): DuplicatePairView {
  return {
    key: pair.key,
    left: personChoice(pair.left.path),
    right: personChoice(pair.right.path),
    reasons: pair.reasons.map(duplicateReasonView),
  };
}
