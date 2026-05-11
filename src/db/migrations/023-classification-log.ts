import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Intent classification log — every time frontdesk calls the
 * classify_intent tool, the host persists a row here. Purpose:
 *
 *   1. Observability: you can finally see what frontdesk is routing to
 *      what (and what it thought the confidence was) without scraping
 *      container logs.
 *   2. Ground truth for regression: this is the seed dataset for any
 *      future "did we route correctly?" testing. Without it, tuning the
 *      frontdesk prompt is flying blind.
 *   3. Audit: when a worker does the wrong thing, you can trace back to
 *      what frontdesk intended.
 *
 * Intentionally append-only. No retention sweep yet — size is small
 * (hundreds of bytes per row, at most per routed inbound message).
 * Once volume matters, add a TTL pass similar to inbound_dedup.
 */
export const migration023: Migration = {
  version: 23,
  name: 'classification-log',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS classification_log (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at         TEXT NOT NULL,
        session_id          TEXT,
        agent_group_id      TEXT,
        user_id             TEXT,
        user_message        TEXT,
        recommended_worker  TEXT,
        confidence          REAL,
        candidates          TEXT,
        reasoning           TEXT,
        action              TEXT NOT NULL,
                            -- 'delegate' | 'clarify' | 'reject' |
                            -- 'answer_self'
        outcome_ref         TEXT
                            -- optional: id of the resulting outbound
                            -- (a2a message or ask_user_question card).
                            -- Lets you correlate "we classified X,
                            -- then we sent Y".
      );
      CREATE INDEX IF NOT EXISTS idx_classification_log_at ON classification_log(occurred_at);
      CREATE INDEX IF NOT EXISTS idx_classification_log_user ON classification_log(user_id, occurred_at);
      CREATE INDEX IF NOT EXISTS idx_classification_log_worker ON classification_log(recommended_worker, occurred_at);
    `);
  },
};
