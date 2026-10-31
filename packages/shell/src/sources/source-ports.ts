import type { HttpPort, SecretStorePort, SqliteSourcePort } from '@dfai/application';

/** What sources reach outside the vault through: feeds, SQLite files, and the secrets feeds send. */
export interface SourcePorts {
  readonly http: HttpPort;
  readonly sqlite: SqliteSourcePort;
  readonly secrets: SecretStorePort;
}
