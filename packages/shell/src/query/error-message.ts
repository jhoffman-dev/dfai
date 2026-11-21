import { failureWords } from '@dfai/domain';

/**
 * What went wrong, as words for the view's error line: a query the index
 * stopped at its budget in plain words (#919), anything else as it was said.
 */
export const errorMessage = (error: unknown): string => failureWords(error);
