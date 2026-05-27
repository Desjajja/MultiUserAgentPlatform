/**
 * Interactive module — generic ask_user_question flow.
 *
 * Container-side `ask_user_question` writes a chat-sdk card to outbound.db +
 * polls inbound.db for a `question_response` system message. On the host side
 * this module handles the button-click response: look up the pending_questions
 * row, write the response into the session's inbound.db, wake the container.
 *
 * The `createPendingQuestion` call in `deliverMessage` (delivery.ts) stays
 * inline in core — it's 15 lines guarded by `hasTable('pending_questions')`,
 * modularizing it adds more registry surface than it saves.
 *
 * Phase 2 (confirm-tokens): when the click's `pendingAction` is set, mint
 * a one-shot X-User-Confirm token under the clicker's identity and stamp
 * it onto the inbound row alongside the click. The agent's next-turn
 * `erp_execute` reads it back from inbound and adds X-User-Confirm.
 */
import { getDb, hasTable } from '../../db/connection.js';
import { deletePendingQuestion, getPendingQuestion, getSession } from '../../db/sessions.js';
import { wakeContainer } from '../../container-runner.js';
import { mintConfirmToken } from '../../erp-confirm-token.js';
import { registerResponseHandler, type ResponsePayload } from '../../response-registry.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';

async function handleInteractiveResponse(payload: ResponsePayload): Promise<boolean> {
  if (!hasTable(getDb(), 'pending_questions')) return false;

  const pq = getPendingQuestion(payload.questionId);
  if (!pq) return false;

  const session = getSession(pq.session_id);
  if (!session) {
    log.warn('Session not found for pending question', { questionId: payload.questionId, sessionId: pq.session_id });
    deletePendingQuestion(payload.questionId);
    return true; // claimed — we owned this questionId even though the session is gone
  }

  // If the clicked button carries a pendingAction, mint a confirm-token
  // under the clicker's identity. Token is bound to (open_id, action,
  // payload_hash) so the agent can't tamper with the payload between
  // click and execute. On any failure the token stays unset — the agent
  // sees the click but no confirm token, and will surface the failure
  // to the user instead of half-executing.
  let confirmToken: { token: string; expiresInSec: number } | null = null;
  if (payload.pendingAction && payload.userId) {
    // userId is namespaced ("feishu:ou_xxx"); strip the channel prefix
    // for ERP. ERP expects raw open_id.
    const openId = payload.userId.startsWith('feishu:')
      ? payload.userId.slice('feishu:'.length)
      : payload.userId;
    if (/^ou_[A-Za-z0-9]+$/.test(openId)) {
      try {
        confirmToken = await mintConfirmToken({
          openId,
          action: payload.pendingAction.operation,
          payload: payload.pendingAction.payload,
        });
        if (!confirmToken) {
          log.warn('confirm-token mint returned null', {
            questionId: payload.questionId,
            operation: payload.pendingAction.operation,
          });
        }
      } catch (err) {
        log.error('confirm-token mint threw', {
          questionId: payload.questionId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const selectedLabel = payload.selectedLabel || payload.value;
  writeSessionMessage(session.agent_group_id, session.id, {
    id: `qr-${payload.questionId}-${Date.now()}`,
    // Use kind=chat so the poll-loop sees this as a wake event and starts
    // a fresh turn. Earlier `kind=system` would be filtered out — fine
    // for the previous blocking design (the MCP tool was polling), but
    // useless for the non-blocking design where the agent's prior turn
    // has already ended and we need to start a new one.
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: pq.platform_id,
    channelType: pq.channel_type,
    threadId: pq.thread_id,
    content: JSON.stringify({
      // Marker so the formatter can render this as "user clicked button"
      // instead of plain text. Also includes the questionId so the agent
      // can correlate to the card it sent earlier in this session.
      kind: 'button_click',
      questionId: payload.questionId,
      selectedOption: payload.value,
      selectedLabel,
      senderId: payload.userId ?? '',
      sender: payload.userId ?? 'feishu-user',
      text: `[用户点了按钮: ${selectedLabel}] (questionId=${payload.questionId})`,
      // When a confirm-token was successfully minted, embed it + the
      // pending action's operation here. erp_execute on the next turn
      // reads inbound, finds the matching questionId row, pulls out
      // confirmToken, and forwards as X-User-Confirm header.
      ...(confirmToken && payload.pendingAction
        ? {
            confirmToken: confirmToken.token,
            confirmTokenExpiresInSec: confirmToken.expiresInSec,
            pendingActionOperation: payload.pendingAction.operation,
          }
        : {}),
      ...(payload.pendingAction && !confirmToken
        ? {
            // Help the agent diagnose: the user clicked a write-button
            // but we couldn't mint a token. The agent should surface
            // this to the user rather than retry blindly.
            confirmTokenError: 'mint_failed',
            pendingActionOperation: payload.pendingAction.operation,
          }
        : {}),
    }),
  });

  deletePendingQuestion(payload.questionId);
  log.info('Question response routed', {
    questionId: payload.questionId,
    selectedOption: payload.value,
    sessionId: session.id,
    hasConfirmToken: !!confirmToken,
  });

  await wakeContainer(session);
  return true;
}

registerResponseHandler(handleInteractiveResponse);
