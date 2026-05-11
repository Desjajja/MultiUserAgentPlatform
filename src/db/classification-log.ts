import { getDb } from './connection.js';

export interface ClassificationLogEntry {
  sessionId?: string | null;
  agentGroupId?: string | null;
  userId?: string | null;
  userMessage?: string | null;
  recommendedWorker?: string | null;
  confidence?: number | null;
  candidates?: string[] | null;
  reasoning?: string | null;
  action: 'delegate' | 'clarify' | 'reject' | 'answer_self';
  outcomeRef?: string | null;
}

export function recordClassification(entry: ClassificationLogEntry, now: Date = new Date()): void {
  getDb()
    .prepare(
      `INSERT INTO classification_log
         (occurred_at, session_id, agent_group_id, user_id, user_message,
          recommended_worker, confidence, candidates, reasoning, action, outcome_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      now.toISOString(),
      entry.sessionId ?? null,
      entry.agentGroupId ?? null,
      entry.userId ?? null,
      entry.userMessage ? entry.userMessage.slice(0, 500) : null,
      entry.recommendedWorker ?? null,
      entry.confidence ?? null,
      entry.candidates ? JSON.stringify(entry.candidates) : null,
      entry.reasoning ? entry.reasoning.slice(0, 1000) : null,
      entry.action,
      entry.outcomeRef ?? null,
    );
}

export interface ClassificationQueryOptions {
  limit?: number;
  userId?: string;
  recommendedWorker?: string;
  action?: ClassificationLogEntry['action'];
  since?: string;
}

export function queryClassificationLog(options: ClassificationQueryOptions = {}): Array<Record<string, unknown>> {
  const where: string[] = [];
  const params: Array<string> = [];
  if (options.userId) {
    where.push('user_id = ?');
    params.push(options.userId);
  }
  if (options.recommendedWorker) {
    where.push('recommended_worker = ?');
    params.push(options.recommendedWorker);
  }
  if (options.action) {
    where.push('action = ?');
    params.push(options.action);
  }
  if (options.since) {
    where.push('occurred_at >= ?');
    params.push(options.since);
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(options.limit ?? 100, 1000));
  return getDb()
    .prepare(`SELECT * FROM classification_log ${whereClause} ORDER BY id DESC LIMIT ?`)
    .all(...params, limit) as Array<Record<string, unknown>>;
}
