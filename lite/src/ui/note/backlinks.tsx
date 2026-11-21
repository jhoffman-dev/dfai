import { useMemo } from 'react';
import { noteTitle } from '../../application/index.ts';
import type { VaultPath } from '../../domain/vault/index.ts';
import { useApp } from '../services.ts';
import { useVault } from '../state/vault-store.ts';

/** The notes that link here: a quiet list under the note. Nothing when there are none. */
export function Backlinks({ path }: { path: VaultPath }) {
  const { services } = useApp();
  const version = useVault((vault) => vault.version);
  const sources = useMemo(
    () => services.session.index.backlinks(path),
    // `version` is the cue: the index answers afresh after any change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [services, path, version],
  );
  if (sources.length === 0) return null;

  return (
    <section className="backlinks" aria-labelledby="backlinks-heading">
      <h2 id="backlinks-heading" className="backlinks-heading">
        Linked from
      </h2>
      <ul className="backlinks-list">
        {sources.map((source) => (
          <li key={source}>
            <a href={`#/note/${encodeURIComponent(source)}`}>{noteTitle(source)}</a>
            <span className="backlinks-summary">{services.session.index.summary(source)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
