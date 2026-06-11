# FrontLane Agent Platform Specification

## Overview

FrontLane is an enterprise-oriented multi-user agent platform.

Its primary deployment model is:

```text
Feishu / CLI
  -> frontdesk agent
  -> user-scoped session
  -> worker agents
  -> ERP gateway
  -> ERP / approval / permission systems
```

The platform is responsible for message ingress, session isolation, agent routing, tool execution, and reply delivery. Business authorization, approval policy, audit, and long-term memory are intentionally pushed to the ERP gateway layer.

## Product Positioning

FrontLane is not a generic personal assistant shell.

It is designed for:

- multiple employees sharing one enterprise bot entrypoint
- per-user context isolation by default
- frontdesk-to-worker delegation
- Feishu-first enterprise deployment
- ERP-backed authorization and memory

It is not designed to encode ERP-specific business rules inside the model runtime.

## Core Components

### Host

The host is a Node.js process that owns:

- the central SQLite database
- inbound routing
- outbound delivery
- session lifecycle
- enterprise auto-wiring
- worker spawning

### Channels

Channels adapt external messaging systems into the platform routing model.

Current baseline channels:

- `feishu`
- `cli`

Feishu supports:

- private chat
- group chat
- `@bot` mentions
- long-connection event delivery
- webhook callbacks
- reaction-based progress status

### Frontdesk Agent

The frontdesk agent is the enterprise entrypoint.

Responsibilities:

- receive employee requests
- interpret intent
- decide whether to answer directly or delegate
- route work to worker agents
- preserve the employee's session boundary while delegating

The frontdesk should not become the permanent owner of business permissions. It may ask for authorization context, but the final decision belongs to the ERP gateway.

### Worker Agents

Workers execute bounded business capabilities such as:

- access control queries
- sales lookups
- finance tasks
- approval assistance
- operations support

Workers can be called through agent-to-agent routing and can inherit the caller's root session context when configured with `a2aSessionMode=root-session`.

### Agent Runner

Each active session runs inside an isolated containerized agent runner. The runner owns:

- model provider integration
- MCP tools
- workspace-local notes
- session transcript handling

The host and runner communicate through per-session SQLite files and filesystem signals, not direct process IPC.

### ERP Gateway

The ERP gateway is the stable backend contract between FrontLane and any concrete ERP system.

Recommended endpoints:

- `POST /describe`
- `POST /authorize`
- `POST /execute`
- `POST /memory/get`
- `POST /memory/upsert`

This layer should own:

- user mapping
- permission checks
- approval checks
- idempotency
- audit logging
- long-term memory persistence
- ERP-specific schema translation

## Session Isolation Model

### Private Chat

Private chat should default to one isolated session per employee. Employee A and employee B must not share context.

### Group Chat

Group chat should usually run in one of these modes:

- `per-user`
- `per-user-per-thread`

This keeps each employee's context isolated even inside the same group. The group itself is treated as a coordination surface, not a trust boundary for sensitive writes.

### Worker Session Mode

For enterprise delegation, worker groups should normally use:

```text
a2aSessionMode=root-session
```

This means the delegated worker sees the same root employee context that originated the request, rather than a shared worker-global conversation.

## Memory Model

FrontLane has two memory layers.

### Short-Term Working Memory

Short-term context lives in the current session history and container workspace. This is useful for ongoing reasoning and temporary notes.

### Long-Term Business Memory

Long-term business memory should use:

```text
memoryMode=erp
```

In this mode, durable memory is stored behind the ERP gateway instead of the agent workspace. Recommended records include:

- user preferences
- business summaries
- approval history
- permission hints
- structured customer or task context

## Message Flow

Typical private-chat flow:

1. Feishu sends a message event to FrontLane.
2. The router resolves the sender, conversation, and session scope.
3. Enterprise autowire connects the sender to `frontlane-template-frontdesk` if needed.
4. The frontdesk session is woken and processes the request.
5. If needed, frontdesk delegates to a worker agent.
6. The worker uses ERP Gateway tools for authorization, execution, or memory.
7. The final reply is delivered back through Feishu.

## Concurrency Model

FrontLane scales through session-level isolation:

- different users map to different sessions
- each active session can wake its own agent runner
- frontdesk can delegate work to multiple worker agents
- reaction-based progress avoids sending noisy placeholder text

This is the basis for enterprise concurrency. The platform should scale by increasing session and worker parallelism, not by sharing one global agent context across all employees.

## Security Boundaries

Security is intentionally layered:

- channel layer: message origin and basic routing
- session layer: user-scoped context isolation
- container layer: runner isolation
- gateway layer: authorization, approval, audit, long-term memory

Important rule:

High-risk writes must not rely only on chat-layer heuristics or group membership. They should require ERP gateway authorization.

## Extension Model

FrontLane is meant to be extended in three stable directions:

- channel adapters
- model providers
- ERP gateway implementations

The goal is to keep the platform core generic while allowing business systems to vary behind the gateway.

## Non-Goals

FrontLane does not try to be:

- a full ERP implementation
- a generic workflow engine
- a replacement for backend authorization
- a shared global memory for all employees

## Observability Spec

FrontLane observability 统一遵循 `docs/specs/observability.md`。它涵盖：

- Span 命名 schema（19 个 top-level namespace，2-3 段 lowercase snake_case）
- OpenInference 属性矩阵（`openinference.span.kind`、`session.id`、`input.value`/`output.value`）
- Business tag taxonomy（`metadata.span_scope`、`route_label`、`turn_result`）
- Trace 拓扑规则（`interaction.*` 业务根 span、pre-session 分离、W3C traceparent 跨进程传播）
- 反噪声纪律（no-empty-loop guard、禁止 duplicate spans）

**约束**：任何新增 manual span 必须经过 schema review；新增 top-level namespace 需要 ADR。

## Model Registry（ADR-0020）

### 模型配置统一入口

模型配置从分散的 `.env` + `litellm/config.yaml` + provider 硬编码，迁移到 `model-registry/` 的 YAML Profile Registry：

```yaml
profile:
  id: "deepseek-v4-flash"
  display_name: "DeepSeek V4 Flash"
  provider: "openai"
  family: "deepseek"

endpoint:
  base_url: "https://opencode.ai/zen/go/v1"
  api_key_env: "OPENAI_API_KEY"
  model_path: "openai/deepseek-v4-flash"

capabilities:
  reasoning: true
  streaming: false
  tool_calls: true
  vision: false
  max_context_tokens: 128000
  max_output_tokens: 8192

reasoning:
  effort_levels: ["none", "low", "medium", "high"]
  default_effort: "none"
  capture_reasoning_content: true
  capture_strategy: "dual_message_split"
  custom_attribute_prefix: "custom.reasoning"

cost:
  pricing:
    input_tokens: 0.10
    output_tokens: 0.30
    reasoning_tokens: 0.30
    cache_read_tokens: 0.05
  billable_dimensions: ["input_tokens", "output_tokens", "reasoning_tokens"]
  cost_precision: 6

phoenix:
  model_name_in_phoenix: "deepseek-v4-flash"
  auto_push_pricing: true
```

### 配置加载优先级

1. `MODEL_PROFILE=deepseek-v4-flash` → 加载 `model-registry/profiles/deepseek-v4-flash.yaml`
2. `OPENAI_MODEL=deepseek-v4-flash`（无 `MODEL_PROFILE`）→ 查询 `model-registry/index.yaml` 的 `env_overrides` 映射
3. 无环境变量 → 使用 `model-registry/index.yaml` 的 `default_profile`

### 新增目录结构

```
model-registry/
├── index.yaml
├── profiles/
│   ├── deepseek-v4-flash.yaml
│   ├── gpt-4o.yaml
│   └── claude-sonnet-4.yaml
└── pricing/
    └── base-pricing.yaml
```

## 上下文可见性 + 推理/成本追踪（ADR-0020）

### 上下文可见性

| 维度 | Phoenix 原生 | MUAP 补充 |
|---|---|---|
| Input/Output messages | `llm.input_messages` / `llm.output_messages` | 不需要 |
| System prompt | 通过 `role="system"` 显示 | 确保 `instructions` 正确传入 |
| Token 统计 | `gen_ai.usage.*`（LiteLLM 自动） | 不需要 |
| Prompt 版本 | Phoenix Prompts 管理 | `llm.prompt_template.*` 属性注入 |
| 上下文组装链路 | 不支持 | 建议 `context.assembly` 自定义 span |

### 推理内容捕获

当 `capture_reasoning_content: true` 时，采用**双消息拆分 workaround**：

```typescript
const outputMessages = [
  { role: "assistant", content: reasoningContent },  // 推理过程
  { role: "assistant", content: finalAnswer },       // 最终答案
];
```

等 OpenInference PR #1642 落地后，迁移到原生 `message.reasoning_content`。

### 成本追踪

新增 `UsageEvent` 字段：

```typescript
interface UsageEvent {
  type: 'usage';
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;      // 新增
  reasoningContent?: string;     // 新增
  costEstimate?: number;         // 新增（基于 profile 定价本地计算）
  durationMs?: number;
  transport?: string;
  modelProfile?: string;         // 新增
}
```

成本计算函数：

```typescript
export function calculateCost(profile, usage) {
  const pricing = profile.cost?.pricing;
  if (!pricing) return { totalCost: 0, currency: 'USD' };
  const inputCost = (usage.inputTokens / 1_000_000) * pricing.input_tokens;
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.output_tokens;
  const reasoningCost = usage.reasoningTokens
    ? (usage.reasoningTokens / 1_000_000) * (pricing.reasoning_tokens || pricing.output_tokens)
    : 0;
  return {
    inputCost: Number(inputCost.toFixed(6)),
    outputCost: Number(outputCost.toFixed(6)),
    reasoningCost: Number(reasoningCost.toFixed(6)),
    totalCost: Number((inputCost + outputCost + reasoningCost).toFixed(6)),
    currency: 'USD',
  };
}
```

## Prompt 版本追踪（ADR-0020）

### 设计原则

- **Registry 不替代 Prompts**：Model Registry 管理模型接入配置，Phoenix Prompts 管理提示词模板
- **运行时依赖**：Prompt 版本信息在运行时注入 trace，不阻塞 LLM 调用（Phoenix 不可用则 fallback 到本地版本号）
- **向后兼容**：现有硬编码 `instructions` 继续有效，逐步迁移到 Phoenix Prompts 管理

### 运行时注入

```typescript
span.setAttribute('llm.prompt_template.name', promptName);
span.setAttribute('llm.prompt_template.version', versionId);
span.setAttribute('llm.prompt_template.variables', JSON.stringify(variables));
span.setAttribute('llm.prompt_template.tag', tag);
```

### 追踪维度

| 属性 | 来源 | 用途 |
|---|---|---|
| `llm.prompt_template.name` | Phoenix Prompt identifier | 追踪使用了哪个 prompt |
| `llm.prompt_template.version` | Phoenix Prompt version ID | 追踪具体版本 |
| `llm.prompt_template.variables` | 运行时变量 | 追踪变量值（注意敏感信息脱敏） |
| `llm.prompt_template.tag` | Phoenix Tag（production/staging） | 追踪环境 |

### 与 Model Registry 集成

```yaml
# model-registry/profiles/*.yaml
prompts:
  default_prompt: "frontlane-frontdesk-system"
  supported_tags: ["production", "staging", "experimental"]
```

## Naming and Compatibility

Some low-level script names, env vars, metric names, and migration notes still use legacy identifiers inherited from the original fork history. Those are treated as transitional — the active product identity, default enterprise topology, and current docs all use `FrontLane`.
