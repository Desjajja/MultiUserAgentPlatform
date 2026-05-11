import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Close the classification → outcome loop.
 *
 * Migration 023 left two holes that a review correctly flagged:
 *
 *   1. `outcome_ref` existed in the schema but nothing in the codebase
 *      wrote it, so the table was a one-way record of agent intentions
 *      with no correlation back to what actually happened.
 *   2. There was no way to find a prior classification by the id the
 *      container returns to the agent — `classification_id` wasn't a
 *      column at all.
 *
 * This migration adds `classification_id` (the id the tool returns and
 * the agent threads into send_message / ask_user_question), plus three
 * supporting columns for richer analytics that the original commit
 * intentionally or unintentionally dropped:
 *
 *   - `channel_type` / `platform_id` / `thread_id` — the full identity
 *     context from RequestIdentity. Migration 023 only kept `user_id`.
 *
 * Backfill: pre-migration rows have no classification_id — they stay
 * NULL, which is fine (the correlation queries ignore NULL ids).
 */
export const migration024: Migration = {
  version: 24,
  name: 'classification-closing-the-loop',
  up: (db: Database.Database) => {
    const cols = new Set(
      (db.prepare("PRAGMA table_info('classification_log')").all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has('classification_id')) {
      db.exec('ALTER TABLE classification_log ADD COLUMN classification_id TEXT');
      db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_classification_log_cls_id ON classification_log(classification_id)',
      );
    }
    if (!cols.has('channel_type')) {
      db.exec('ALTER TABLE classification_log ADD COLUMN channel_type TEXT');
    }
    if (!cols.has('platform_id')) {
      db.exec('ALTER TABLE classification_log ADD COLUMN platform_id TEXT');
    }
    if (!cols.has('thread_id')) {
      db.exec('ALTER TABLE classification_log ADD COLUMN thread_id TEXT');
    }
  },
};
