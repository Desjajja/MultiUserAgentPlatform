# FrontLane Observability Specification

> **版本**: v2.1 (merged)  
> **位置**: `docs/specs/observability.md`  
> **适用范围**: FrontLane / MUAP host 与 runner 的 manual spans; third-party auto-instrumentation 可共存，但不支配 MUAP naming。  
> **关联 ADR**: ADR-0007, ADR-0011, ADR-0014, ADR-0016, ADR-0017, ADR-0018, ADR-0020

---

## 1. 为什么需要这份 Spec

之前 PR-O2 的实现把 `withSpan` 当成"加日志"——结果：

- Phoenix UI 列表：14 个 column 中只有 `name` / `latency` / `start time` 有值，其它全 `unknown` / `--`
- Phoenix Sessions 视图：HUMAN / AI 卡片全是 `undefined`
- Trace 列表被空轮询 span 淹没

根因：**OpenTelemetry tracing 没有"语义"**。span 名字 + latency 在工程系统里够用，但 Phoenix 是为 AI 系统设计的可观测性平台，它的 UI 是**OpenInference schema 驱动**的。不按 schema 喂数据，等于关掉 Phoenix 90% 的能力。

这份 spec 把 Phoenix 的 schema 内化为接入纪律，涵盖：
- **命名规范**（§3）——可扩展的层级 + 可聚合的 low-cardinality
- **属性矩阵**（§4）——每个 span 必须带哪些 OpenInference / OTel attributes
- **业务标签**（§5）——Phoenix 中按业务维度过滤的 metadata taxonomy
- **Trace 拓扑**（§6）——root span 选址、跨进程传播、pre-session 分离
- **ADR-0020 扩展**（§7）——模型元数据注册表、上下文可见性、推理/成本追踪、Prompt 版本追踪

---

## 2. 核心概念

### 2.1 Trace 拓扑

```
trace（一次用户请求）
  └─ root span  ←  必须有 session.id 才能进入 Phoenix Sessions 分组
      ├─ child span（自动继承 session.id via OTel context）
      ├─ child span
      └─ ...（跨进程时用 W3C traceparent 续接）
```

**Phoenix 只看 root span 的 `session.id`** 来分组 trace。子 span 设不设 session.id 不影响分组（但建议显式设，便于直接查询）。

### 2.2 OpenInference 是 AI 语义层

OpenInference 是 OpenTelemetry 之上的 AI 专用语义规范。它定义了一套属性键 + 枚举值，让 Phoenix UI 知道：

- 这个 span 是什么类型的 AI 操作（`openinference.span.kind`）
- 输入是什么（`input.value` / `input.mime_type`）
- 输出是什么（`output.value` / `output.mime_type`）
- 属于哪个会话（`session.id`）
- 哪个用户（`user.id`）
- LLM 用了多少 token（`llm.token_count.*`）
- 完整的对话消息列表（`llm.input_messages.*` / `llm.output_messages.*`）

**没有这些属性 = Phoenix 退化成普通 trace 查看器。**

### 2.3 Phoenix Sessions 视图

Sessions 视图把同一 `session.id` 的所有 trace 按时间线排列，每个 trace 显示一对 HUMAN / AI 卡片。卡片内容来自 root span 的 `input.value` / `output.value`。

---

## 3. Span Naming Schema（Naming Grammar）

### 3.1 Canonical grammar

- `<span-name> = <subsystem> "." <entity-or-operation> ["\." <action>]`
- `<subsystem> = lowercase ALPHA *(ALPHA / DIGIT / "_")`
- `<entity-or-operation> = lowercase ALPHA *(ALPHA / DIGIT / "_")`
- `<action> = lowercase ALPHA *(ALPHA / DIGIT / "_")`

### 3.2 Hard rules

1. **2-3 segments only** — `router.route` ✅, `mcp.erp.approve.purchase.order` ❌
2. **lowercase only** — `agent.turn` ✅, `Agent.Turn` ❌
3. **snake_case throughout** — segment 内可用 `_`，不可用 `-`
4. **hyphen forbidden** — span names 不是 file names
5. **present-tense / operation form only** — `receive`, `send`, `deliver` ✅, `received` ❌
6. **no dynamic values in names** — 不允许 session_id, user_id, message id 等
7. **no service names / model names in the span path** — 用 attributes 表达
8. **second segment should stay coarse** — `mcp.erp.execute` ✅, `mcp.erp.approve_purchase_order` ❌

### 3.3 Top-Level Namespace Catalog（19 个）

| Namespace | Domain | Default Kind | Status | Example |
|---|---|---|---|---|
| `platform.*` | host/platform spine spans | `CHAIN` | Active | `platform.channel.receive` |
| `router.*` | inbound routing / session resolution | `CHAIN` | Active | `router.deliver_to_agent` |
| `delivery.*` | (reserved — migrated to `platform.delivery.*`) | `CHAIN` | Reserved | — |
| `container.*` | (reserved — migrated to `platform.container.*`) | `CHAIN` | Reserved | — |
| `session.*` | session lifecycle governance | `CHAIN` | Reserved | `session.archive` |
| `sweep.*` | periodic sweeper real-work units | `CHAIN` | Reserved | `sweep.run` |
| `agent.*` | container-side agent lifecycle | `AGENT` | Planned | `agent.turn` |
| `provider.*` | LLM provider request boundary | `LLM` | Planned | `provider.request` |
| `mcp.*` | MCP tool surface by family | `TOOL` | Planned | `mcp.erp.execute` |
| `erp.*` | ERP gateway HTTP/RPC boundary | `TOOL` | Planned | `erp.call` |
| `identity.*` | identity resolution / propagation | `CHAIN` | Reserved | `identity.resolve` |
| `module.*` | platform modules under `src/modules/` | `CHAIN` | Active | `module.a2a.route` |
| `db.*` | bounded logical aggregates only | `TOOL` | Reserved | `db.session.write` |
| `bootstrap.*` | startup / topology bootstrap | `CHAIN` | Reserved | `bootstrap.topology.init` |
| `circuit.*` | circuit-breaker control points | `CHAIN` | Reserved | `circuit.open` |
| `config.*` | config resolution / validation | `CHAIN` | Reserved | `config.resolve` |
| `mock.*` | simulation / test doubles | `TOOL` | Planned | `mock.erp.execute` |
| `hardware.*` | hardware-facing service boundaries | `TOOL` | Planned | `hardware.robot.execute` |
| `gui.*` | GUI automation service boundaries | `TOOL` | Planned | `gui.chromeleon.run` |
| `python_skill.*` | Python skill service execution | `TOOL` | Planned | `python_skill.run` |

**Registration rule**: new top-level namespace requires ADR; new 2nd/3rd segment requires schema amendment.

### 3.4 Standard Sub-Operations

| Namespace | Allowed Patterns | Examples |
|---|---|---|
| `channel.*` | `channel.<channel>.receive` | `channel.cli.receive`, `channel.feishu.receive` |
| `router.*` | `router.route`, `router.deliver_to_agent` | `router.deliver_to_agent` (session-trace root) |
| `platform.delivery.*` | `platform.delivery.drain`, `platform.delivery.message`, `platform.delivery.send` | `platform.delivery.send` |
| `platform.container.*` | `platform.container.wake`, `platform.container.spawn`, `platform.container.kill` | `platform.container.spawn` |
| `session.*` | `session.open`, `session.close`, `session.archive` | `session.archive` |
| `sweep.*` | `sweep.run` | `sweep.run` |
| `agent.*` | `agent.run`, `agent.turn`, `agent.cancel` | `agent.turn` |
| `provider.*` | `provider.request` | `provider.request` |
| `mcp.*` | `mcp.<group>.<tool>` | `mcp.erp.execute`, `mcp.core.send_message` |
| `erp.*` | `erp.call` | `erp.call` |
| `identity.*` | `identity.resolve`, `identity.propagate` | `identity.resolve` |
| `db.*` | `db.<aggregate>.<action>` | `db.session.read`, `db.audit.write` |
| `module.*` | `module.<slug>.<action>` | `module.a2a.route`, `module.permissions.check_sender` |

### 3.5 Migration Registry（已落地重命名）

| Old name | New name | Action |
|---|---|---|
| `router.container.wake` | — | DELETE |
| `delivery.session.drain` | `platform.delivery.drain` | Rename |
| `delivery.message.deliver` | `platform.delivery.message` | Rename |
| `delivery.channel.send` | `platform.delivery.send` | Rename |
| `container.wake` | `platform.container.wake` | Rename |
| `container.spawn` | `platform.container.spawn` | Rename |
| `container.kill` | `platform.container.kill` | Rename |
| `cli.event.received` | `platform.channel.receive` | Rename |
| `feishu.event.received` | `platform.channel.receive` | Rename |

---

## 4. Required Attributes Per Span

### 4.1 Global required

| 属性键 | 类型 | 取值 | 说明 |
|---|---|---|---|
| `openinference.span.kind` | string enum | `LLM` / `EMBEDDING` / `CHAIN` / `RETRIEVER` / `RERANKER` / `TOOL` / `AGENT` / `GUARDRAIL` / `EVALUATOR` / `PROMPT` | 必填 |

### 4.2 Required on Root Span

| 属性键 | 类型 | 说明 |
|---|---|---|
| `session.id` | string | 同一会话所有 trace 的分组键 |
| `input.value` | string | 用户请求文本（HUMAN 卡片） |
| `input.mime_type` | string | `text/plain` 或 `application/json` |

### 4.3 Required on Output-bearing Span

| 属性键 | 类型 | 说明 |
|---|---|---|
| `output.value` | string | AI 回复文本（AI 卡片） |
| `output.mime_type` | string | `text/plain` |

### 4.4 Attribute Matrix by Span Class

| Span class | Kind | Required | Conditionally required | Notes |
|---|---|---|---|---|
| Root spans | `AGENT` | `session.id`, `user.id`, `input.value`, `input.mime_type` | `output.value`, `output.mime_type` | `interaction.frontdesk` / `interaction.worker` |
| Output-bearing | family-specific | `output.value`, `output.mime_type` | `message.kind`, `channel.type` | `platform.delivery.send`, `agent.turn` |
| LLM spans | `LLM` | `llm.system`, `llm.model_name`, `llm.invocation_parameters`, `llm.input_messages`, `llm.output_messages` | `llm.token_count.*` | one per model invocation |
| TOOL spans | `TOOL` | `tool.name`, `tool.parameters` | `tool.output`, `erp.operation` | `mcp.erp.execute`, `erp.call` |
| CHAIN spans | `CHAIN` | none beyond kind | `session.id`, `user.id`, `message.kind` | orchestration glue |
| AGENT spans | `AGENT` | none beyond kind | `session.id`, `user.id`, `output.value` | `agent.run`, `agent.turn` |
| `agent.turn` | `CHAIN` | `session.id`, `agent.group.id`, `provider` | `agent.turn.index` | container-side; child via W3C traceparent |

### 4.5 Span Kind 映射规则

| 业务场景 | 推荐 kind | 例子 |
|---|---|---|
| 编排器 / 入口 / 协调多步 | `CHAIN` | router, channel handler, delivery |
| 自主 AI Agent 思考一步 | `AGENT` | container 内 agent 的 plan/act 循环 |
| 实际调 LLM API | `LLM` | OpenAI 完成、Claude 完成 |
| 调外部 API / IO | `TOOL` | DB 查询、HTTP 调外部服务 |
| 向量检索 | `RETRIEVER` | RAG 检索阶段 |
| 重排 | `RERANKER` | reranker 模型 |
| 嵌入向量生成 | `EMBEDDING` | embedding API 调用 |
| 内容审核 | `GUARDRAIL` | moderation / 安全过滤 |
| 自动评估 | `EVALUATOR` | 在线评测 |
| Prompt 模板渲染 | `PROMPT` | 模板填充阶段 |

---

## 5. Business Tag Taxonomy（v2.0）

所有业务维度作为 key 写入**单个 `metadata` JSON 对象**，再编码为 span 的 `metadata` attribute。

### 5.1 主要分类标签

| metadata key | 类型 | 必填 | 合法值 | 说明 |
|---|---|---|---|---|
| `span_scope` | string | ✅ | `business` / `platform` / `tool` / `routing` | 主要过滤维度 |

### 5.2 业务层标签（仅业务根 span）

| metadata key | 类型 | 必填 | 合法值 | 说明 |
|---|---|---|---|---|
| `route_label` | string | ✅（业务根） | `frontdesk` / `worker` / `erp` | 路由归属 |
| `entrypoint` | string | 条件 | `chat` / `erp` / `system` | 触发来源 |
| `turn_result` | string | 条件 | `answered` / `delegated` / `failed` / `dropped` | 轮次完成状态 |
| `delegate_to` | string | 条件 | 最大 80 字符 | `turn_result=delegated` 时设置 |

### 5.3 路由决策标签

| metadata key | 类型 | 必填 | 合法值 | 说明 |
|---|---|---|---|---|
| `classify_id` | string | 条件 | — | 分类日志 ID |
| `route_reason` | string | 条件 | 最大 500 字符 | 路由决策摘要 |
| `route_score` | number | 条件 | 0..1 | 路由置信度 |
| `selected_agent` | string | 条件 | 最大 80 字符 | 选中 agent/group |
| `agent_options` | string | 条件 | JSON 数组，最多 5 项 | 候选 agent 列表 |
| `access_result` | string | 条件 | `allow` / `deny` / `skip` | 访问控制结果 |
| `engage_mode` | string | 条件 | `direct` / `a2a` | A2A 派活的唯一承载点 |

### 5.4 ERP 标签

| metadata key | 类型 | 必填 | 合法值 | 说明 |
|---|---|---|---|---|
| `used_erp` | boolean | 条件 | `true` / `false` | chat-to-ERP 时为 true |
| `biz_domain` | string | 条件 | `erp` / `sales` / `approval` / `finance` / `ops` | 业务域 |
| `erp_op` | string | 条件 | — | ERP 操作名 |

### 5.5 工具层标签

| metadata key | 类型 | 必填 | 合法值 | 说明 |
|---|---|---|---|---|
| `tool_group` | string | 条件 | — | 工具分组 |

### 5.6 平台层标签

| metadata key | 类型 | 必填 | 合法值 | 说明 |
|---|---|---|---|---|
| `component` | string | ✅（平台 span） | `container` / `delivery` / `channel` / `router` / `agent` | 平台组件 |

### 5.7 通用标签

| metadata key | 类型 | 必填 | 合法值 | 说明 |
|---|---|---|---|---|
| `agent_group` | string | 条件 | 任意 | Agent Group 名称 |
| `session_mode` | string | 条件 | `shared` / `per-user` / `per-user-per-thread` | 会话模式 |
| `provider` | string | 条件 | `claude` / `openai` / `sdk-openai` | AI 模型提供者 |
| `failure_category` | string | 条件 | `provider_timeout` / `auth_denied` / `container_oom` | 业务级失败分类 |

### 5.8 Span 分类架构

**Business Layer**（`metadata.span_scope = 'business'`）：

| Span 名称 | Kind | 说明 |
|---|---|---|
| `interaction.frontdesk` | `AGENT` | frontdesk agent 处理的一次用户交互 |
| `interaction.worker` | `AGENT` | worker agent 处理的一次用户交互 |
| `interaction.erp` | `AGENT` | 纯 ERP 入口触发（**reserved**） |

**Platform Layer**（`metadata.span_scope = 'platform'`）：

| Span 名称 | Kind | 说明 |
|---|---|---|
| `platform.channel.receive` | `CHAIN` | 通道消息接收 |
| `platform.container.wake` | `CHAIN` | 容器唤醒尝试 |
| `platform.container.spawn` | `CHAIN` | 容器创建 |
| `platform.container.kill` | `CHAIN` | 容器终止 |
| `platform.delivery.drain` | `CHAIN` | session 出站队列批量消费 |
| `platform.delivery.message` | `CHAIN` | 单条消息投递 |
| `platform.delivery.send` | `CHAIN` | 通道消息发送 |
| `platform.agent.turn` | `CHAIN` | 容器内单次推理周期 |
| `platform.router.drop` | `CHAIN` | 无目标 agent 时的路由诊断 |
| `platform.router.deny` | `CHAIN` | 访问控制拒绝时的路由诊断 |

**Tool Layer**（`metadata.span_scope = 'tool'`）：

| Span 名称 | Kind | 说明 |
|---|---|---|
| `mcp.classify` | `TOOL` | classify_intent MCP 工具调用 |
| `mcp.erp` | `TOOL` | ERP gateway MCP 工具调用 |
| `erp.call` | `TOOL` | ERP gateway HTTP/RPC 边界调用 |

### 5.9 标签设置位置示例

```
interaction.frontdesk / interaction.worker  (AGENT)
  metadata.span_scope  = 'business'
  metadata.route_label = 'frontdesk' | 'worker'
  metadata.entrypoint  = 'chat'
  metadata.agent_group = <group name>
  metadata.session_mode = <mode>
  metadata.engage_mode  = 'direct' | 'a2a'
  metadata.classify_id  = <id>          # 分类完成后 merge
  metadata.route_reason = <summary>     # 分类完成后 merge
  metadata.route_score  = <0..1>        # 分类完成后 merge
  metadata.selected_agent = <name>      # 分类完成后 merge
  metadata.used_erp     = true          # ERP audit 完成后 merge
  metadata.biz_domain   = 'erp'         # ERP audit 完成后 merge
  metadata.turn_result  = 'answered' | 'delegated' | 'failed' | 'dropped'
  metadata.delegate_to  = <agent>       # delegated 时设置

platform.channel.receive  (CHAIN)
  metadata.span_scope = 'platform'
  metadata.component  = 'channel'
  # 禁止 route_label、input.value、output.value

platform.container.wake | spawn | kill  (CHAIN)
  metadata.span_scope = 'platform'
  metadata.component  = 'container'
  # 禁止 route_label、route_type

platform.delivery.drain | message | send  (CHAIN)
  metadata.span_scope = 'platform'
  metadata.component  = 'delivery'
  # 禁止 route_label、route_type、output.value

platform.agent.turn  (CHAIN, container-side)
  metadata.span_scope = 'platform'
  metadata.component  = 'agent'
  # 使用 messages_in.traceparent 作为父上下文
  # 禁止复制完整 input.value / output.value

mcp.classify  (TOOL)
  openinference.span.kind = TOOL
  tool.name               = 'classify_intent'
  tool.parameters         = <JSON 参数，安全截断>
  metadata.span_scope     = 'tool'
  metadata.tool_group     = 'classify'

mcp.erp / erp.call  (TOOL)
  openinference.span.kind = TOOL
  tool.name               = <ERP MCP 工具名>
  tool.parameters         = <JSON 参数，安全截断>
  metadata.span_scope     = 'tool'
  metadata.biz_domain     = 'erp'
  metadata.erp_op         = <操作名>
```

### 5.10 Phoenix 过滤语法

```text
# 所有业务轮次（最常用主过滤）
metadata["span_scope"] == "business"

# Frontdesk 轮次
name == "interaction.frontdesk"

# Worker 轮次
name == "interaction.worker"

# 使用了 ERP 的 chat 轮次
metadata["span_scope"] == "business" and metadata["used_erp"] == true

# 仅平台 span
metadata["span_scope"] == "platform"

# 仅工具 span
metadata["span_scope"] == "tool"

# A2A 委托轮次
metadata["engage_mode"] == "a2a"

# 按 span kind 过滤
span_kind == "AGENT"
```

---

## 6. Trace Topology Rules

### 6.1 Root distinction

- **session-trace root**: 进入 Phoenix Sessions grouping 的 canonical root
- **pre-session span**: 在 session 解析之前发生的 ingress / routing short span

**当前 locked rule**: `interaction.frontdesk` / `interaction.worker` 是 Phoenix Sessions 视图意义上的 root。它们拥有完整的 `input.value`/`output.value`，`session.id` 在此设置 + setSession context wrap，向下传播给所有 container / delivery 子 span。

### 6.2 Pre-session behavior

`channel.*.receive` 与 `router.route` 都属于 **pre-session span**。它们 **MUST**：
- 要么在 suppressed context 下创建；
- 要么各自作为 separate short traces 存在；
- 但不能抢占 `interaction.*` 的 session root 语义。

### 6.3 Current topology

```
pre-session short trace #1: platform.channel.receive
pre-session short trace #2: router.route
session trace root: interaction.frontdesk / interaction.worker / interaction.erp（reserved）
  - child: platform.container.wake
  - child: platform.delivery.drain
  - child: platform.delivery.message
  - child: platform.delivery.send
  - child: mcp.classify (TOOL)
  - child: mcp.erp / erp.call (TOOL)
  - child: platform.agent.turn → provider.request (LLM)
```

### 6.4 Container boundary

host -> container 通过 W3C traceparent 传播：
- **Startup traceparent**: `OTEL_TRACEPARENT` 环境变量在 `platform.container.spawn` 时注入
- **Per-turn traceparent**: frontdesk→worker A2A 委托时，host 将活跃 `interaction.*` 根 span 的 W3C traceparent 写入 `messages_in.traceparent` 字段

`OTEL_TRACEPARENT` 是 transport carrier，不是 span-name segment，也不是 namespace。

### 6.5 Root span lifecycle bridge

`router.deliver_to_agent` 根 span 的生命周期跨越 router 和 delivery 两个模块：
- **创建**: `src/router.ts` 中 `tracer.startActiveSpan('router.deliver_to_agent', ...)`
- **存储**: `storeSessionRootSpan(sessionId, span)` 存入 `rootSpanBridge` Map
- **结束（正常）**: `src/delivery.ts` drain 完成后调用 `endSessionRootSpan(sessionId, lastDeliveredText)`
- **结束（异常）**: `src/container-runner.ts` 在 container crash/error/kill 时调用 `failSessionRootSpan(sessionId, error)`

幂等保证：`endSessionRootSpan` 和 `failSessionRootSpan` 先从 Map 中 delete 再 end，第二次调用为 no-op。

### 6.6 LiteLLM Proxy span layer

LiteLLM Proxy 作为 MUAP 的 LLM 网关，通过其内置的 `arize_phoenix` callback 自动产出符合 GenAI 语义规范的 spans。这些 spans 不由 MUAP 代码控制，属于 third-party auto-instrumentation。

**Span hierarchy（由 LiteLLM 自动产出）**:
```
Received Proxy Server Request  (SpanKind=SERVER)
  litellm_request              (SpanKind=INTERNAL)
    raw_gen_ai_request         (SpanKind=INTERNAL)
```

**关键 attributes（由 LiteLLM 自动填充）**:

| Attribute | 含义 |
|---|---|
| `gen_ai.usage.input_tokens` | 本次请求消耗的 input token 数 |
| `gen_ai.usage.output_tokens` | 本次请求消耗的 output token 数 |
| `gen_ai.cost.total` | 本次请求的估算费用 |
| `gen_ai.request.model` | 请求时指定的 model 名称 |
| `gen_ai.response.model` | 实际响应的 model 名称 |
| `gen_ai.input.messages` | 请求消息列表 |
| `gen_ai.output.messages` | 响应消息列表 |

**service.name**: `litellm-proxy`

**MUAP 的责任边界**：MUAP 不重命名这些 spans，也不修改它们的 attributes。MUAP 的唯一职责是确保容器侧出站 HTTP 请求正确注入 `traceparent` header。

### 6.7 Container OTel spans

PR-O3 为容器 agent-runner 新增最小化 OTel 初始化：

| Span | kind | 含义 |
|---|---|---|
| `agent.turn` | `CHAIN` | 包裹单次 LLM 调用 + tool execution cycle |

Required attributes:
- `openinference.span.kind`: `CHAIN`
- `session.id`: 当前会话 ID
- `agent.group.id`: agent group 标识
- `metadata`: JSON attribute，至少含 `layer='ai'`、`route_type`（反映真实 lane）、`lane`、`provider`

Optional: `agent.turn.index`（当前 turn 在本次会话中的序号，从 0 开始）

**service.name**: `agent-runner-{session_id_prefix}`

---

## 7. ADR-0020 扩展：模型元数据注册表 + 上下文可见性 + 推理/成本追踪

> 本节将 ADR-0020 中关于可观测性模块的扩展反向总结为 spec 新增 items。

### 7.1 模型元数据注册表（Model Metadata Registry）

#### 7.1.1 背景

当前模型配置散落在 `.env`（`OPENAI_MODEL=deepseek-v4-flash`）、`infra/litellm/config.yaml`（模型列表）、provider 源码（硬编码 fallback）中。多模型接入时缺乏统一的 metadata 层。

#### 7.1.2 决策

新增 `model-registry/` 目录，通过 `MODEL_PROFILE` 环境变量指向 YAML profile 文件，集中管理模型元数据、定价、能力标记、推理配置。

#### 7.1.3 Profile Schema

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

#### 7.1.4 配置加载优先级

```
1. MODEL_PROFILE=deepseek-v4-flash
   → 加载 model-registry/profiles/deepseek-v4-flash.yaml
2. OPENAI_MODEL=deepseek-v4-flash（无 MODEL_PROFILE）
   → 查询 model-registry/index.yaml 的 env_overrides.OPENAI_MODEL 映射
3. 无环境变量
   → 使用 model-registry/index.yaml 的 default_profile
```

#### 7.1.5 新增目录结构

```
model-registry/
├── index.yaml                    # 注册表索引
├── profiles/
│   ├── deepseek-v4-flash.yaml    # 当前默认模型
│   ├── gpt-4o.yaml
│   └── claude-sonnet-4.yaml
└── pricing/
    └── base-pricing.yaml         # 可选基础定价表
```

### 7.2 上下文可见性（Context Visibility）

#### 7.2.1 Phoenix 原生能力

| 可见性需求 | Phoenix 原生能力 | 是否需要 MUAP 侧补充 |
|---|---|---|
| Input messages | `llm.input_messages` 自动显示 | ❌ 不需要 |
| Output messages | `llm.output_messages` 自动显示 | ❌ 不需要 |
| System prompt | `llm.input_messages.0.message.role == "system"` | ✅ 需确保 `instructions` 被正确传入 |
| Token 统计 | `gen_ai.usage.input_tokens` / `output_tokens` | ❌ 不需要（LiteLLM 自动生成） |
| Prompt 版本 | Phoenix Prompts 管理 | ✅ 可选：`using_prompt_template` 注入 |
| 上下文组装链路 | ❌ 不支持 | ✅ 建议新增 `context.assembly` 自定义 span |

#### 7.2.2 MUAP 侧补充方案

在 `agent.turn` span 中新增上下文属性：

```typescript
span.setAttribute('context.system_prompt_id', 'frontlane-template-v1');
span.setAttribute('context.instructions_hash', hash(instructions));
span.setAttribute('context.message_count', messages.length);
span.setAttribute('context.estimated_tokens', estimateTokens(messages));
```

### 7.3 Reasoning Content 捕获

#### 7.3.1 UsageEvent 扩展

```typescript
interface UsageEvent {
  type: 'usage';
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;      // 新增
  reasoningContent?: string;     // 新增（workaround）
  costEstimate?: number;         // 新增（基于 profile 定价）
  durationMs?: number;
  transport?: string;
  modelProfile?: string;         // 新增
}
```

#### 7.3.2 双消息拆分 workaround

当 `capture_reasoning_content: true` 时：

```typescript
const outputMessages = [
  { role: "assistant", content: reasoningContent },  // 推理过程
  { role: "assistant", content: finalAnswer },       // 最终答案
];
```

等 OpenInference PR #1642 落地后，可迁移到原生 `message.reasoning_content`。

### 7.4 成本计算模块

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

### 7.5 Prompt 版本追踪（高优先级）

#### 7.5.1 设计原则

- **Registry 不替代 Prompts**：Model Registry 管理模型接入配置，Phoenix Prompts 管理提示词模板
- **运行时依赖**：Prompt 版本信息在运行时注入 trace，不阻塞 LLM 调用
- **向后兼容**：现有硬编码 `instructions` 继续有效，逐步迁移到 Phoenix Prompts 管理

#### 7.5.2 目录结构

```
prompts/
├── system-prompts/
│   ├── frontdesk-template.yaml     # frontdesk 系统提示词模板
│   ├── worker-default.yaml         # worker 默认提示词
│   └── erp-gateway.yaml          # ERP gateway 提示词
└── versions/
    └── frontdesk-template/
        ├── v1.0.yaml
        ├── v1.1.yaml
        └── v2.0.yaml
```

#### 7.5.3 运行时注入

```typescript
// 在 agent.turn span 中注入属性
span.setAttribute('llm.prompt_template.name', promptName);
span.setAttribute('llm.prompt_template.version', versionId);
span.setAttribute('llm.prompt_template.variables', JSON.stringify(variables));
span.setAttribute('llm.prompt_template.tag', tag);
```

#### 7.5.4 追踪维度

| 属性 | 来源 | 用途 |
|---|---|---|
| `llm.prompt_template.name` | Phoenix Prompt identifier | 追踪使用了哪个 prompt |
| `llm.prompt_template.version` | Phoenix Prompt version ID | 追踪具体版本 |
| `llm.prompt_template.variables` | 运行时变量 | 追踪变量值（注意敏感信息脱敏） |
| `llm.prompt_template.tag` | Phoenix Tag（production/staging） | 追踪环境 |

#### 7.5.5 与 Model Registry 的集成

```yaml
# model-registry/profiles/deepseek-v4-flash.yaml
profile:
  id: "deepseek-v4-flash"
  # ...

prompts:
  default_prompt: "frontlane-frontdesk-system"
  supported_tags: ["production", "staging", "experimental"]
```

### 7.6 新增 Spec Items 总结

| 维度 | 新增 Item | 来源 ADR-0020 章节 |
|---|---|---|
| 模型配置 | YAML Profile Registry 统一模型元数据 | §5.1, §5.2 |
| 多模型支持 | `groups.*` 分组机制支持前端模型选择、A/B 测试 | §5.1 |
| 上下文可见性 | `context.system_prompt_id`, `context.instructions_hash`, `context.message_count`, `context.estimated_tokens` | §5.3 |
| 推理内容 | `reasoningTokens`, `reasoningContent`（双消息拆分 workaround） | §5.4 |
| 成本追踪 | `costEstimate`（基于 profile 定价的本地计算） | §5.5 |
| Prompt 版本 | `llm.prompt_template.name`, `llm.prompt_template.version`, `llm.prompt_template.variables`, `llm.prompt_template.tag` | §5.10 |

---

## 8. 反噪声纪律

**span 必须代表"真实的业务工作"，不是"代码经过这里"。**

### 8.1 经验法则

写完一个 `withSpan(...)` 后问自己：

1. 这次执行**有可能**没做实际工作就返回吗？（空 poll、无消息、无变更）
2. 如果无工作时也会创建 span → 重构，把 span 移到"已知有工作"之后
3. 如果工作内容是"打开数据库 / 关闭数据库 / 心跳" → 不该是 span

### 8.2 严禁的反模式

| ❌ 错误 | 影响 |
|---|---|
| `span.end()` 之后再 `setAttribute` | 属性丢失 |
| 属性键拼错（如 `input` 不是 `input.value`） | Phoenix UI 不识别 |
| Root span 不设 session.id | 整个 trace 不进 Sessions 视图 |
| 不同 trace 共用 session.id 但相互无关 | Sessions 视图错误聚合 |
| 把 polling / sweep / heartbeat 加 span | 列表噪声，淹没真消息 |

### 8.3 重构 pattern

把"可能为空"的 span 改造为"已知非空才创建"：

```typescript
// BEFORE - span 包了整个函数（即使无工作也 fire）
async function drainSession(s) {
  await withSpan('platform.delivery.drain', { 'session.id': s.id }, async () => {
    const allDue = getDueOutboundMessages(outDb);
    if (allDue.length === 0) return;  // ← span 已创建，浪费
    // ...
  });
}

// AFTER - 先检查工作量，仅在有真消息时创建 span
async function drainSession(s) {
  const allDue = getDueOutboundMessages(outDb);
  if (allDue.length === 0) return;
  const undelivered = allDue.filter(m => !delivered.has(m.id));
  if (undelivered.length === 0) return;

  await withSpan('platform.delivery.drain', {
    'session.id': s.id,
    'openinference.span.kind': 'CHAIN',
    'message.count': undelivered.length,
  }, async () => {
    for (const msg of undelivered) await deliverMessage(msg, ...);
  });
}
```

---

## 9. 实现机制

### 9.1 host 端

```typescript
import { getMetadataAttributes } from '@arizeai/openinference-core';
// applyBusinessTags 内部：
span.setAttributes(getMetadataAttributes({
  span_scope: 'business',
  route_label: 'frontdesk',
  entrypoint: 'chat',
  ...
}));
```

host 已装 `@arizeai/openinference-core@2.2.0`，无需新依赖。

### 9.2 container 端

container（`container/agent-runner/`）**无** `@arizeai` 依赖，使用本地 helper（`container/agent-runner/src/observability/metadata.ts`）输出等价 `{ metadata: JSON.stringify(record) }`。

### 9.3 metadata 合并

`metadata` 是**单个** JSON attribute。同一 span 多次写入业务维度时必须 union，不能后写覆盖先写。分类路由数据和 ERP 数据通过 `updateSessionRootSpanTags` 追加到活跃根 span，不替换已有字段。

---

## 10. 验证 SQL（Phoenix Postgres）

```sql
-- 1. 移除的噪声 span 不再出现
SELECT name, count(*) FROM spans
WHERE name IN ('delivery.poll.active','host.sweep','host.sweep.sessions','router.container.wake')
GROUP BY name;
-- 期望：空结果

-- 2. delivery.session.drain 计数应该约等于实际触发的消息数
SELECT name, count(*) FROM spans WHERE name = 'platform.delivery.drain';
-- 期望：不是几百

-- 3. openinference.span.kind 已设
SELECT name, attributes->>'openinference.span.kind' AS kind, count(*)
FROM spans GROUP BY name, kind ORDER BY name;
-- 期望：每个 span 都有非 NULL 的 kind 值

-- 4. session.id 已在 root span 设置
SELECT t.trace_id, s.name AS root_span, s.attributes->>'session.id' AS session_id
FROM traces t JOIN spans s ON s.trace_rowid = t.id AND s.parent_id IS NULL
ORDER BY t.id DESC LIMIT 10;
-- 期望：session_id 全部非 NULL

-- 5. input.value / output.value 已填
SELECT name, left(attributes->>'input.value', 60) AS input_preview,
       left(attributes->>'output.value', 60) AS output_preview
FROM spans WHERE attributes ? 'input.value' OR attributes ? 'output.value'
ORDER BY start_time DESC LIMIT 10;
-- 期望：能看到真实消息片段

-- 6. 业务标签过滤验证
SELECT name, span_kind, attributes->'metadata'->>'span_scope' AS scope
FROM spans WHERE attributes->'metadata'->>'span_scope' IS NOT NULL
ORDER BY start_time DESC LIMIT 10;
-- 期望：所有最近 spans 都有 metadata.span_scope
```

---

## 11. 变更历史

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.0 | 2026-05 | 初始 schema：OpenInference span kind、命名空间、trace topology |
| v1.1 | 2026-06 | 加入 LiteLLM Proxy、容器侧 OTel、root span bridge |
| v1.2 | 2026-06-02 | 加入 layer separation、business tag taxonomy（flat `muap.*`）、agent.turn span |
| v1.3 | 2026-06-07 | 迁移到 OpenInference `metadata` 命名空间；`route_type` taxonomy 重构；Phoenix 17.2.0。见 ADR-0017 |
| v1.4 | 2026-06-09 | `interaction.*` 业务根 span；`span_scope` 取代 `layer`+`route_type`；平台 span 迁移到 `platform.*`；工具 span 用 TOOL 语义；`messages_in.traceparent` A2A 续接。见 ADR-0018 |
| **v2.0** | 2026-06-09 | **合并版**：将 observability-business-tags.md、observability-instrumentation-methodology.md、observability-span-schema.md 合并为统一 spec；保留全部 normative contract |
| **v2.1** | 2026-06-10 | **新增 ADR-0020 扩展**：模型元数据注册表、上下文可见性、推理内容捕获、成本计算、Prompt 版本追踪 |

---

## 12. 废弃说明

以下字段/模式在 v2.0+ 中弃用，不得在新代码中使用：

| 弃用项 | 替换方案 |
|---|---|
| `metadata.layer = 'ai'` 作为业务 span 标识 | `metadata.span_scope = 'business'` |
| `metadata.layer = 'platform'` | `metadata.span_scope = 'platform'` |
| `metadata.route_type`（打在平台/工具 span 上） | 平台/工具 span 不携带路由标签 |
| `metadata.route_type` 作为主要业务过滤字段 | `metadata.span_scope = 'business'` + span 名称 |
| `metadata.lane` | 废弃，不再使用 |
| `router.deliver_to_agent` 作为 Phoenix Sessions 主根 span | `interaction.frontdesk` / `interaction.worker` |
| 旧长字段名（`observability_scope`、`route_rationale_summary` 等） | 见 ADR-0018 弃用字段表 |
| `msg.kind` | canonical key 是 `message.kind` |

---

**审批后归档路径**：本文件作为 `docs/specs/observability.md` 保留，是 LLM-facing source of truth；任何 Sub-agent 在改动 `src/observability/` 或新增 span 之前，**必须**先读这一篇。
