/**
 * The vault owner's name for the API, which is built before the profile is
 * read (the same shape as `createAutomationRelay`): the app points it at the
 * name as the profile holds it, and a request reads it as it arrives.
 */
export interface OwnerNameRelay {
  /** The name now, null when the profile has none or has not been read. */
  readonly name: () => string | null;
  readonly point: (name: string | null) => void;
}

export function createOwnerNameRelay(): OwnerNameRelay {
  let owner: string | null = null;
  return {
    name: () => owner,
    point: (next) => {
      owner = next;
    },
  };
}
