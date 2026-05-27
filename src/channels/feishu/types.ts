/**
 * Shared Feishu type definitions. Kept free of runtime code so callers can
 * import types without pulling in the adapter + SDK.
 */
export type FeishuEventMode = 'webhook' | 'long-connection' | 'hybrid';

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  encryptKey?: string;
  verificationToken?: string;
  webhookPath: string;
  baseUrl: string;
  requestTimeoutMs: number;
  bodyTimeoutMs: number;
  maxBodyBytes: number;
  botOpenId?: string;
  botName?: string;
  eventMode: FeishuEventMode;
  // ERP backend coordinates for ingress-side commands like /bind. The
  // adapter intercepts these so credentials never enter the agent
  // container's context.
  erpBaseUrl?: string;
  erpServiceKey?: string;
}

export interface FeishuTenantTokenResponse {
  code?: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
}

export interface FeishuApiResponse {
  code?: number;
  msg?: string;
  data?: Record<string, unknown>;
}

export interface FeishuReactionOperator {
  operator_type?: 'app' | 'user';
}

export interface FeishuReactionItem {
  reaction_id?: string;
  operator?: FeishuReactionOperator;
  reaction_type?: {
    emoji_type?: string;
  };
}

export interface FeishuMessageEvent {
  sender: {
    sender_id: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
  };
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    thread_id?: string;
    chat_id: string;
    chat_type: 'p2p' | 'private' | 'group';
    message_type: string;
    content: string;
    create_time?: string;
    mentions?: Array<{
      key?: string;
      name?: string;
      id?: {
        open_id?: string;
        user_id?: string;
        union_id?: string;
      };
    }>;
  };
}

export interface FeishuCardActionEvent {
  operator: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
    name?: string;
  };
  token: string;
  action: {
    value: Record<string, unknown>;
    tag?: string;
  };
  context: {
    open_id?: string;
    user_id?: string;
    chat_id?: string;
    // Feishu sets these on V2 card.action.trigger events. We patch the
    // original card via `PATCH /open-apis/im/v1/messages/{open_message_id}`
    // immediately after handling the click so the user gets instant
    // "button greyed out / processing" feedback instead of waiting on the
    // agent's next turn.
    open_message_id?: string;
    open_chat_id?: string;
  };
}

export interface FeishuReceiveTarget {
  receiveId: string;
  receiveIdType: 'chat_id' | 'open_id' | 'user_id';
}

export interface FeishuQuestionActionPayload {
  kind: 'frontlane.ask_question';
  questionId: string;
  selectedOption: string;
  selectedLabel?: string;
  expectedUserId?: string;
  expiresAt?: number;
  /**
   * Optional L2-write payload attached to this specific button. When set,
   * handleCardAction calls ERP /api/confirm-tokens to mint a one-shot
   * X-User-Confirm token bound to (operator, action, payload_hash) and
   * stamps it onto the inbound row alongside the click so the next turn's
   * erp_execute can include it.
   *
   * Buttons that omit `pendingAction` (e.g. cancel / later) get no token
   * — the agent sees the click but knows no L2 write was authorized.
   */
  pendingAction?: {
    operation: string;
    payload: Record<string, unknown>;
  };
}

export interface NormalizedQuestionOption {
  label: string;
  value: string;
  selectedLabel: string;
  pendingAction?: {
    operation: string;
    payload: Record<string, unknown>;
  };
}

export interface TokenCacheEntry {
  token: string;
  expiresAt: number;
}
