/** What went wrong, as words for the view's error line. */
export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
