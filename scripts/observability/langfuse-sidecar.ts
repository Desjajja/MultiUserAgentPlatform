#!/usr/bin/env -S node --experimental-strip-types
/**
 * FrontLane → Langfuse sidecar (Phase 3.1 of migration plan 块 3).
 *
 * Scans all per-session outbound.db files every POLL_INTERVAL_MS and pushes
 * new chat messages to Langfuse as traces. Each session_id maps 1:1 to a
 * Langfuse trace; each new chat message becomes a span on that trace.
 *
 * Limitations (per plan):
 *   - Only captures outbound chat messages (what the agent says back).
 *     LLM input/output tokens, tool_use details, reasoning chains are not
 *     available at this layer — they need the deeper Phase 3.2 plugin.
 *   - No trace_id propagation between frontdesk/worker turns. A dispatch
 *     chain shows up as separate traces, not one linked tree.
 *
 * Configuration via env:
 *   LANGFUSE_HOST           default http://localhost:3000
 *   LANGFUSE_PUBLIC_KEY     required (pk-lf-*)
 *   LANGFUSE_SECRET_KEY     required (sk-lf-*)
 *   POLL_INTERVAL_MS        default 5000
 *   STATE_FILE              default /tmp/frontlane-langfuse-cursor.json
 *
 * Run: `node --experimental-strip-types scripts/observability/langfuse-sidecar.ts`
 * Or:  `bun run scripts/observability/langfuse-sidecar.ts`
 *
 * Stop: SIGTERM / Ctrl-C — drains in-flight batch then exits.
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const REPO_ROOT = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), '..', '..');
const SESSIONS_ROOT = path.join(REPO_ROOT, 'data', 'v2-sessions');
const V2_DB = path.join(REPO_ROOT, 'data', 'v2.db');

const LANGFUSE_HOST = process.env.LANGFUSE_HOST ?? 'http://localhost:3000';
const LANGFUSE_PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY ?? '';
const LANGFUSE_SECRET_KEY = process.env.LANGFUSE_SECRET_KEY ?? '';
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? '5000');
const STATE_FILE = process.env.STATE_FILE ?? '/tmp/frontlane-langfuse-cursor.json';

if (!LANGFUSE_PUBLIC_KEY || !LANGFUSE_SECRET_KEY) {
  console.error('LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY env vars are required');
  process.exit(1);
}

const AUTH = 'Basic ' + Buffer.from(`${LANGFUSE_PUBLIC_KEY}:${LANGFUSE_SECRET_KEY}`).toString('base64');

interface SessionInfo {
  id: string;
  agentGroupId: string;
  groupName: string;
}

interface OutboundRow {
  seq: number;
  id: string;
  kind: string;
  content: string;
  timestamp: string;
  traceId: string | null;
}

interface InboundRow {
  seq: number;
  id: string;
  kind: string;
  content: string;
  timestamp: string;
  sourceSessionId: string | null;
  originUserId: string | null;
  traceId: string | null;
}

interface Cursor {
  [sessionId: string]: { outboundSeq: number; inboundSeq: number };
}

function readCursor(): Cursor {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as Cursor;
  } catch {
    return {};
  }
}

function writeCursor(cursor: Cursor): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(cursor, null, 2));
}

function listActiveSessions(): SessionInfo[] {
  const sql = `SELECT s.id, s.agent_group_id, g.name AS group_name FROM sessions s
               LEFT JOIN agent_groups g ON s.agent_group_id = g.id
               WHERE s.status = 'active';`;
  const out = execSync(`sqlite3 -separator '|' "${V2_DB}" "${sql}"`, { encoding: 'utf8' }).trim();
  if (!out) return [];
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, agentGroupId, groupName] = line.split('|');
      return { id, agentGroupId, groupName: groupName || agentGroupId };
    });
}

function readNewOutbound(session: SessionInfo, sinceSeq: number): OutboundRow[] {
  const db = path.join(SESSIONS_ROOT, session.agentGroupId, session.id, 'outbound.db');
  if (!fs.existsSync(db)) return [];
  // trace_id was added in Phase 3.3; older DBs may not have it. COALESCE
  // through an empty string so the column shape is stable for parsing.
  try {
    const sql = `SELECT seq, id, kind, content, timestamp, COALESCE(trace_id, '') FROM messages_out WHERE seq > ${sinceSeq} ORDER BY seq;`;
    const out = execSync(`sqlite3 -separator $'\\t' "${db}" "${sql}"`, { encoding: 'utf8' }).trim();
    if (!out) return [];
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [seq, id, kind, content, timestamp, traceId] = line.split('\t');
        return { seq: Number(seq), id, kind, content, timestamp, traceId: traceId || null };
      });
  } catch {
    // Schema older than trace_id rollout — re-try without the column.
    try {
      const sql = `SELECT seq, id, kind, content, timestamp FROM messages_out WHERE seq > ${sinceSeq} ORDER BY seq;`;
      const out = execSync(`sqlite3 -separator $'\\t' "${db}" "${sql}"`, { encoding: 'utf8' }).trim();
      if (!out) return [];
      return out
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [seq, id, kind, content, timestamp] = line.split('\t');
          return { seq: Number(seq), id, kind, content, timestamp, traceId: null };
        });
    } catch {
      return [];
    }
  }
}

function readNewInbound(session: SessionInfo, sinceSeq: number): InboundRow[] {
  const db = path.join(SESSIONS_ROOT, session.agentGroupId, session.id, 'inbound.db');
  if (!fs.existsSync(db)) return [];
  try {
    const sql = `SELECT seq, id, kind, content, timestamp, COALESCE(source_session_id, ''), COALESCE(origin_user_id, ''), COALESCE(trace_id, '') FROM messages_in WHERE seq > ${sinceSeq} ORDER BY seq;`;
    const out = execSync(`sqlite3 -separator $'\\t' "${db}" "${sql}"`, { encoding: 'utf8' }).trim();
    if (!out) return [];
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [seq, id, kind, content, timestamp, sourceSessionId, originUserId, traceId] = line.split('\t');
        return {
          seq: Number(seq),
          id,
          kind,
          content,
          timestamp,
          sourceSessionId: sourceSessionId || null,
          originUserId: originUserId || null,
          traceId: traceId || null,
        };
      });
  } catch {
    // Schema older than trace_id rollout — re-try without it.
    try {
      const sql = `SELECT seq, id, kind, content, timestamp, COALESCE(source_session_id, ''), COALESCE(origin_user_id, '') FROM messages_in WHERE seq > ${sinceSeq} ORDER BY seq;`;
      const out = execSync(`sqlite3 -separator $'\\t' "${db}" "${sql}"`, { encoding: 'utf8' }).trim();
      if (!out) return [];
      return out
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [seq, id, kind, content, timestamp, sourceSessionId, originUserId] = line.split('\t');
          return {
            seq: Number(seq),
            id,
            kind,
            content,
            timestamp,
            sourceSessionId: sourceSessionId || null,
            originUserId: originUserId || null,
            traceId: null,
          };
        });
    } catch {
      return [];
    }
  }
}

interface IngestionItem {
  id: string;
  type: 'trace-create' | 'span-create' | 'generation-create';
  timestamp: string;
  body: Record<string, unknown>;
}

async function pushToLangfuse(items: IngestionItem[]): Promise<void> {
  if (items.length === 0) return;
  const res = await fetch(`${LANGFUSE_HOST}/api/public/ingestion`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: AUTH,
    },
    body: JSON.stringify({ batch: items }),
  });
  const body = await res.text().catch(() => '');
  if (res.status === 207) {
    // Partial success — log any per-item errors
    try {
      const parsed = JSON.parse(body) as { successes?: unknown[]; errors?: Array<{ id: string; message: string; error?: string }> };
      if (parsed.errors && parsed.errors.length > 0) {
        console.error(`[sidecar] partial ingest errors (${parsed.errors.length}/${items.length}):`);
        for (const e of parsed.errors.slice(0, 3)) {
          console.error(`  ${e.id}: ${e.error ?? '?'} ${(e.message ?? '').slice(0, 200)}`);
        }
      }
    } catch {
      console.error(`[sidecar] 207 body parse failed: ${body.slice(0, 200)}`);
    }
  } else if (!res.ok) {
    console.error(`langfuse ingest failed: ${res.status} ${body.slice(0, 200)}`);
  }
}

function makeTraceId(sessionId: string): string {
  return `frontlane-${sessionId}`;
}

function makeSpanId(messageId: string): string {
  return `msg-${messageId}`;
}

/**
 * Coerce SQLite-default timestamps (`YYYY-MM-DD HH:MM:SS`, recorded as UTC by
 * the agent-runner) into the strict ISO 8601 format Langfuse's API validator
 * requires (`YYYY-MM-DDTHH:MM:SS.SSSZ`). Falls back to provided ISO strings,
 * empty inputs, or non-parsable values without throwing.
 */
function toIso(ts: string | null | undefined, fallback: string): string {
  if (!ts) return fallback;
  // Already ISO with timezone — passes Langfuse regex.
  if (/T.*(Z|[+-]\d\d:\d\d)$/.test(ts)) return ts;
  // SQLite "YYYY-MM-DD HH:MM:SS" → assume UTC, swap space → T, append Z.
  const sqliteMatch = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(ts);
  if (sqliteMatch) return `${sqliteMatch[1]}T${sqliteMatch[2]}.000Z`;
  // Last resort — let Date round-trip it.
  const parsed = new Date(ts);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : fallback;
}

function summarize(content: string, max = 500): string {
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed.text === 'string') return parsed.text.slice(0, max);
    return JSON.stringify(parsed).slice(0, max);
  } catch {
    return content.slice(0, max);
  }
}

async function tick(): Promise<void> {
  const cursor = readCursor();
  const sessions = listActiveSessions();
  const items: IngestionItem[] = [];
  const now = new Date().toISOString();

  for (const sess of sessions) {
    const c = cursor[sess.id] ?? { outboundSeq: 0, inboundSeq: 0 };

    // Read inbound first — we need source_session_id from the first inbound
    // to set the Langfuse sessionId for cross-hop linking. All worker traces
    // dispatched from the same frontdesk session group under that frontdesk
    // session id in the Langfuse UI, surfacing the full request flow.
    const inb = readNewInbound(sess, c.inboundSeq);

    // First time seeing this session: create the trace. If this is a worker
    // dispatched from a frontdesk (inbound.source_session_id set), use that
    // upstream session id for grouping. Falls back to own session id for
    // frontdesk and channel-attached sessions.
    if (!cursor[sess.id]) {
      const firstInb = inb[0];
      const groupingSession = firstInb?.sourceSessionId || sess.id;
      const userId = firstInb?.originUserId || undefined;
      items.push({
        id: `trace-init-${sess.id}`,
        type: 'trace-create',
        timestamp: now,
        body: {
          id: makeTraceId(sess.id),
          name: sess.groupName,
          sessionId: groupingSession,
          userId,
          metadata: {
            agent_group_id: sess.agentGroupId,
            worker_session_id: sess.id,
            dispatched_from: firstInb?.sourceSessionId ?? null,
            source: 'frontlane-sidecar',
          },
        },
      });
    }

    // New inbound (user → agent or frontdesk → worker) messages.
    // Phase 3.3: if the row carries a real trace_id, surface it on the span
    // metadata so Langfuse search-by-trace_id works. The trace itself stays
    // pinned to the synthetic per-session id (no breaking change to the
    // existing trace structure); the metadata.trace_id is the cross-session
    // join key for analytics.
    for (const m of inb) {
      const linkBack = m.sourceSessionId && m.sourceSessionId !== sess.id;
      items.push({
        id: `inb-${sess.id}-${m.seq}`,
        type: 'span-create',
        timestamp: toIso(m.timestamp, now),
        body: {
          id: makeSpanId(`in-${m.id}`),
          traceId: makeTraceId(sess.id),
          name: linkBack ? `inbound (dispatched from ${m.sourceSessionId})` : `inbound: ${m.kind}`,
          startTime: toIso(m.timestamp, now),
          input: summarize(m.content),
          metadata: {
            kind: m.kind,
            seq: m.seq,
            direction: 'inbound',
            source_session_id: m.sourceSessionId,
            origin_user_id: m.originUserId,
            trace_id: m.traceId,
          },
        },
      });
      c.inboundSeq = Math.max(c.inboundSeq, m.seq);
    }

    // New outbound (agent → user/peer) messages.
    // kind='llm-usage' rows are observability-only sentinels written by
    // the agent-runner per LLM call — surface them as Langfuse generation
    // observations carrying token + duration metadata. Everything else
    // becomes a plain span.
    const out = readNewOutbound(sess, c.outboundSeq);
    for (const m of out) {
      if (m.kind === 'llm-usage') {
        let usage: Record<string, unknown> = {};
        try {
          usage = JSON.parse(m.content);
        } catch {
          /* malformed content — drop the row */
        }
        items.push({
          id: `gen-${sess.id}-${m.seq}`,
          type: 'generation-create',
          timestamp: toIso(m.timestamp, now),
          body: {
            id: makeSpanId(`gen-${m.id}`),
            traceId: makeTraceId(sess.id),
            name: 'llm-call',
            model: (usage.model as string) || 'unknown',
            startTime: toIso(m.timestamp, now),
            usage: {
              input: usage.inputTokens ?? null,
              output: usage.outputTokens ?? null,
              total: usage.totalTokens ?? null,
              unit: 'TOKENS',
            },
            metadata: {
              transport: usage.transport ?? null,
              duration_ms: usage.durationMs ?? null,
              seq: m.seq,
              trace_id: m.traceId,
            },
          },
        });
      } else {
        items.push({
          id: `out-${sess.id}-${m.seq}`,
          type: 'span-create',
          timestamp: toIso(m.timestamp, now),
          body: {
            id: makeSpanId(`out-${m.id}`),
            traceId: makeTraceId(sess.id),
            name: `outbound: ${m.kind}`,
            startTime: toIso(m.timestamp, now),
            output: summarize(m.content),
            metadata: { kind: m.kind, seq: m.seq, direction: 'outbound', trace_id: m.traceId },
          },
        });
      }
      c.outboundSeq = Math.max(c.outboundSeq, m.seq);
    }

    cursor[sess.id] = c;
  }

  if (items.length > 0) {
    await pushToLangfuse(items);
    console.log(`[sidecar] pushed ${items.length} items (${sessions.length} sessions)`);
  }
  writeCursor(cursor);
}

let stopping = false;
process.on('SIGTERM', () => {
  console.log('SIGTERM received, stopping');
  stopping = true;
});
process.on('SIGINT', () => {
  console.log('SIGINT received, stopping');
  stopping = true;
});

async function main(): Promise<void> {
  console.log(
    `FrontLane → Langfuse sidecar starting (host=${LANGFUSE_HOST}, interval=${POLL_INTERVAL_MS}ms, state=${STATE_FILE})`,
  );
  while (!stopping) {
    try {
      await tick();
    } catch (err) {
      console.error(`tick failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  console.log('sidecar stopped');
}

await main();
