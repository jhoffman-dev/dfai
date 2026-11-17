export { COMPANY_TYPE } from './company.ts';
export {
  isPersonType,
  newPersonRefusal,
  PEOPLE_FOLDER,
  PERSON_TYPE,
  personInitial,
  unlinkableNameReason,
} from './person.ts';
export { personChipFor, personChipLookup, rankMentionSuggestions } from './mention-suggestions.ts';
export type { KnownPerson, MentionSuggestion, PersonChip } from './mention-suggestions.ts';
export {
  addressesMatch,
  addressParts,
  domainsNear,
  editDistanceWithin,
  localPartsMatch,
  DOMAIN_ONE_EDIT_FROM,
  DOMAIN_TWO_EDITS_FROM,
  LOCAL_ONE_EDIT_FROM,
  LOCAL_TWO_EDITS_FROM,
} from './person-similarity.ts';
export type { AddressMatch, AddressParts, LocalMatch } from './person-similarity.ts';
export {
  dismissDuplicateChanges,
  dismissedDuplicates,
  duplicatePairKey,
  NOT_DUPLICATE_PEOPLE_KEY,
  possibleDuplicates,
} from './possible-duplicates.ts';
export type { DuplicateCandidate, DuplicatePair, DuplicateReason } from './possible-duplicates.ts';
export {
  mergedBody,
  mergeVersion,
  personMergeRefusal,
  planPersonMerge,
} from './person-merge-plan.ts';
export type {
  AppendedBody,
  MergeConflict,
  MergeNote,
  PersonMergePlan,
} from './person-merge-plan.ts';
export { addressesIn, givesAddress, personMatch } from './person-match.ts';
export type { PersonCandidate, PersonMatch } from './person-match.ts';
