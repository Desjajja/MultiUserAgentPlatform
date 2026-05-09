import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Marker migration — the session TTL / archive feature uses the existing
 * `sessions.status` column (TEXT). A new 'archived' value is introduced
 * at the code level; no schema change is needed because the column is
 * already permissive. We still record the migration so installers / debug
 * tooling can check "is session archiving active?" from schema_version.
 */
export const migration021: Migration = {
  version: 21,
  name: 'session-archived-status',
  up: (_db: Database.Database) => {
    // No-op: sessions.status already accepts arbitrary TEXT. The host now
    // writes 'archived' in addition to 'active' / 'closed'.
  },
};
