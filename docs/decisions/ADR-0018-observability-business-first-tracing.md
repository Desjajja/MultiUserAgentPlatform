# ADR-0018: Business-First Tracing — `interaction.*` Roots, `span_scope` Taxonomy, and Platform/Tool Isolation

- **Status**: Accepted
- **Date**: 2026-06-09
- **Decider(s)**: 用户（拍板）；coding agent（提案 + 调研 + 执行）
- **Tags**: `observability`, `phase0b`, `tracing`, `phoenix`, `schema-governance`
- **Supersedes**: ADR-0017 的 route-type-first filter 语义（route_type 作为首选业务过滤字段的部分）
- **Superseded by**: —

---

## Context

ADR-0017 确立了 Phoenix 17.2.0 升级和 `metadata` 命名空间迁移。然而，在实际使用 Phoenix UI 调试 Q&A 对时，发现以 `metadata.route_type` 为主要业务过滤维度存在根本性缺陷：

1. **`metadata["route_type"] == "frontdesk"` 返回 `router.route`**：该 span 没有完整的 Q&A 内容，只是路由决策外壳。用户无法通过它看到"这条 frontdesk 消息的问题是什么、回答是什么"。

2. **`metadata["route_type"] == "worker"` 返回混合结果**：`router.deliver_to_agent`、`container.wake`、`delivery.session.drain`、`agent.turn` 等 span 全部命中，业务 Q&A 与平台生命周期混在一起，无法区分。

3. **Phoenix Sessions 视图碎片化**：没有一个稳定的"一条用户消息对应一对 HUMAN/AI 卡片"映射。路由 span 和平台 span 各自带 `input.value`，导致多个 Sessions 气泡出现。

用户明确要求：每次用户可见的对话轮次映射到且仅映射到一个业务根 span，根 span 名字直接反映路由归属，Sessions UI 干净。

---

## Problem Statement

旧设计把 `route_type` 打在所有跨层 span 上（channel、router、delivery、container），本质是把路由标签当日志字段用。这导致：

- **业务过滤无法精确**：`route_type=frontdesk` 返回的不是"frontdesk 处理的 Q&A 对"，而是"所有路由过程中标着 frontdesk 的 span"。
- **Sessions 视图混乱**：多个 span 都有 `input.value`，Phoenix 无法确定哪个是"这次对话的用户输入"。
- **平台 span 污染业务视图**：`container.wake` / `delivery.session.drain` 等平台操作进入业务过滤结果。

---

## Decision

> **拍板：** 以 `interaction.*` 为唯一的用户可见会话根 span；平台 span 隔离到 `platform.*` 命名空间；工具 span 用 OpenInference TOOL 语义。

### 核心规则（不可退步）

1. **每个用户可见轮次有且仅有一个业务根 span**，名字为：
   - `interaction.frontdesk` — frontdesk agent 直接答复
   - `interaction.worker` — worker agent 答复（含 frontdesk→worker 委托后的最终答复）
   - `interaction.erp` — 纯 ERP 入口触发（reserved，当前无运行时发射点，直到出现真实 ERP-originated ingress）

2. **业务根 span 独占完整 I/O**：
   - `input.value` = 用户可见请求文本
   - `output.value` = 用户可见最终答复文本
   - `openinference.span.kind = AGENT`

3. **`span_scope` 是新的主要业务过滤维度**，取代 `route_type` 作为首选过滤字段：
   - `span_scope = business` — 业务根 span（`interaction.*`）
   - `span_scope = platform` — 平台生命周期 span（`platform.*`）
   - `span_scope = tool` — MCP/ERP 工具 span
   - `span_scope = routing` — 纯路由诊断 span（无 input/output）

4. **`route_label`** 替代 `route_type` 作为业务方向标识，只打在业务根 span 上：
   - `route_label = frontdesk | worker | erp`

5. **ERP 双层语义严格区分**：
   - Chat-to-ERP（用户通过聊天触发 ERP 操作）：根 span 保持 `interaction.frontdesk` 或 `interaction.worker`，加 `used_erp=true` 和 `biz_domain=erp`
   - Pure ERP Entry（ERP webhook / 审批回调 / 定时任务直接进入）：根 span 为 `interaction.erp`；`interaction.erp` 是 reserved 状态直到具体 ERP ingress 存在

6. **平台 span 严格隔离**：
   - 使用 `platform.*` 命名空间：`platform.container.wake/spawn/kill`、`platform.delivery.drain/message/send`、`platform.channel.receive`、`platform.agent.turn`
   - 禁止设置 `route_label`、`route_type`、`input.value`、`output.value`
   - 必须设置 `span_scope = platform`

7. **工具 span 用 OpenInference TOOL 语义**：
   - 推荐名称：`mcp.classify`、`mcp.erp`、`erp.call`
   - 必须设置 `openinference.span.kind = TOOL`、`tool.name`、`tool.parameters`
   - 可携带 tool-local I/O，但不得复制完整用户请求和最终答复
   - 必须设置 `span_scope = tool`

8. **`messages_in.traceparent`** 作为 A2A 委托的每轮 trace 上下文载体：
   - frontdesk→worker 委托时，host 把活跃根 span 的 W3C traceparent 写入目标 session 的 inbound 消息行
   - 热/复用 worker 容器从 `messages_in.traceparent` 读取每轮父上下文，而非依赖进程启动时的 `OTEL_TRACEPARENT`

9. **路由详情归并到业务根 span**：
   - 分类路由决策数据（`classify_id`、`route_reason`、`route_score`、`selected_agent`、`agent_options`）作为 metadata/event 打在 `interaction.*` 根 span 上
   - 不再创建单独的 `router.route` 业务 span 作为 Sessions 主过滤目标

---

## Approved Short Metadata Keys

所有 metadata key 使用 2-3 个 snake_case 单词，不超过三个词。

| Key | 类型 | 必填 | 合法值 | 说明 |
|---|---|---|---|---|
| `span_scope` | string | ✅ | `business` / `platform` / `tool` / `routing` | 主要过滤维度，取代 `layer` |
| `route_label` | string | 条件 | `frontdesk` / `worker` / `erp` | 仅业务根 span 设置 |
| `entrypoint` | string | 条件 | `chat` / `erp` / `system` | 触发来源 |
| `biz_domain` | string | 条件 | `erp` / `sales` / `approval` / `finance` / `ops` | 业务域 |
| `used_erp` | boolean | 条件 | `true` / `false` | chat-to-ERP 时为 true |
| `classify_id` | string | 条件 | — | 分类日志 ID |
| `route_reason` | string | 条件 | 最大 500 字符，截断 | 路由决策摘要（非原始 chain-of-thought） |
| `route_score` | number | 条件 | 0..1 | 路由置信度 |
| `selected_agent` | string | 条件 | 最大 80 字符 | 选中的 agent/group |
| `agent_options` | string | 条件 | JSON 数组，最多 5 项，每项 80 字符 | 候选 agent 列表 |
| `access_result` | string | 条件 | `allow` / `deny` / `skip` | 访问控制结果 |
| `erp_op` | string | 条件 | — | ERP 操作名 |
| `tool_group` | string | 条件 | — | 工具分组 |
| `turn_result` | string | 条件 | `answered` / `delegated` / `failed` / `dropped` | 轮次完成状态 |
| `delegate_to` | string | 条件 | 最大 80 字符 | `turn_result=delegated` 时设置 |

已弃用的长字段名（FORBIDDEN）：

| 禁止使用 | 改用 |
|---|---|
| `observability_scope` | `span_scope` |
| `route_rationale_summary` | `route_reason` |
| `route_confidence` | `route_score` |
| `selected_agent_group` | `selected_agent` |
| `candidate_agents` | `agent_options` |
| `classification_id` | `classify_id` |
| `business_domain` | `biz_domain` |
| `access_gate_result` | `access_result` |
| `layer` | `span_scope`（业务/平台/工具维度） |
| `route_type`（作为主要业务过滤字段） | `span_scope` + `route_label` |

---

## Span Topology

```text
interaction.frontdesk / interaction.worker  [AGENT, span_scope=business]
  input.value  = 用户可见请求
  output.value = 用户可见最终答复
  metadata.span_scope  = business
  metadata.route_label = frontdesk | worker
  metadata.classify_id = ...
  metadata.route_reason = 简短摘要
  ├─ mcp.classify        [TOOL, span_scope=tool]
  ├─ mcp.erp / erp.call  [TOOL, span_scope=tool]
  ├─ provider.request    [LLM]
  └─ platform.*          [CHAIN, span_scope=platform]
```

frontdesk→worker 委托路径：

```text
interaction.frontdesk 启动后委托给 worker
  → 根 span 迁移到 worker session（updateName → interaction.worker）
  → route_label 更新为 worker
  → W3C traceparent 写入 messages_in.traceparent
  → worker 容器用 per-turn traceparent 建立 platform.agent.turn
  → worker 输出时：output.value 设在 interaction.worker，turn_result=answered，根 span 结束
```

---

## Phoenix 过滤语法

所有业务轮次：

```text
metadata["span_scope"] == "business"
```

Frontdesk 轮次：

```text
name == "interaction.frontdesk"
```

Worker 轮次：

```text
name == "interaction.worker"
```

使用了 ERP 的 chat 轮次（根 span 不变为 interaction.erp）：

```text
metadata["span_scope"] == "business" and metadata["used_erp"] == true
```

纯 ERP 入口轮次（reserved，当前无发射点）：

```text
name == "interaction.erp"
```

仅看平台 span：

```text
metadata["span_scope"] == "platform"
```

仅看工具 span：

```text
metadata["span_scope"] == "tool"
```

REST API 过滤（Phoenix ≥ 14.9.0）：

```bash
attribute=metadata.span_scope:business
```

PostgreSQL 直查：

```sql
SELECT name, span_kind, attributes->'metadata'->>'route_label' AS route_label
FROM spans
WHERE attributes->'metadata'->>'span_scope' = 'business'
ORDER BY start_time DESC LIMIT 20;
```

---

## Sessions UI Rule

Phoenix Sessions 应为每个 `pnpm chat` 消息显示且仅显示一对 HUMAN/AI 卡片。

- `interaction.*` 根 span 拥有完整 `input.value` / `output.value`
- 子 TOOL/LLM span 可在 Trace 视图中检查
- 路由决策数据作为根 span 的 metadata/event，不产生额外 Sessions 气泡
- 禁止出现携带 `input.value` 的独立 `router.route` span 进入 Sessions 视图

---

## Relation to ADR-0017

ADR-0017 的 Phoenix 17.2.0 升级决策、`metadata` 命名空间迁移、安全硬化 env 配置、以及 `getMetadataAttributes` 编码机制继续有效，是本 ADR 的运行基础。

本 ADR 仅超越 ADR-0017 中以 `metadata.route_type` 作为主要业务维度过滤字段的设计，以 `metadata.span_scope` + `interaction.*` span 名称体系代替。ADR-0017 的 Phoenix 升级部分不受影响。

---

## Consequences

**Positive**：
- Phoenix Sessions 视图每条用户消息对应一对 HUMAN/AI 卡片，清晰无杂音。
- `span_scope=business` 过滤精确返回 `interaction.*` 根 span，不再混入平台 span。
- `interaction.frontdesk` / `interaction.worker` 过滤直接返回包含 Q&A 内容的 span。
- 路由决策、ERP 操作、分类日志可通过 metadata 字段快速关联，无需跨 span 拼接。
- frontdesk→worker 委托后，最终答复归属在 `interaction.worker`，A2A trace 连续。

**Negative**：
- `metadata.route_type` 历史 trace 仍存在于 Phoenix 数据库中，直到保留期过期；新旧数据需用不同过滤条件。
- `interaction.erp` 是 reserved 状态，直到出现真实 ERP-originated ingress 才能发射；过早发射会破坏 ERP 双层语义。

**Neutral / Trade-offs**：
- 旧的 `route_type` 字段可继续在容器侧保留作为兼容 / 诊断用途，但不能作为 Phoenix 业务过滤的主要目标。
- `span_scope` 字段虽与 `layer` 语义有重叠，但比 `layer` 更精确（区分 business / platform / tool / routing 四层）。

---

## Implementation Evidence

Tasks 1-5 of the `observability-business-first-tracing` plan are complete and verified. Specific shipped artifacts:

- `src/observability/business-tags.ts`：`SpanScope`、`RouteLabel`、`BusinessTagKeys`（全部 15 个短字段名）、`interactionSpanName`、`platformSpanName`、`deriveRouteLabel`
- `src/router.ts`：成功路由发射 `interaction.<route_label>` 根 span，失败路径发射 `platform.router.drop/deny`（无 input/output）
- `src/observability/context-bridge.ts`：`updateSessionRootSpanTags`、`transferSessionRootSpan`；分类/ERP 数据 merge 到活跃根 span
- `src/delivery.ts`：三种完成模式（answered/delegated/failed）；系统消息不结束根 span
- `src/container-runner.ts` / `src/channels/`：platform span 全部迁移到 `platform.*` 命名空间，`span_scope=platform`，无 route_label
- `container/agent-runner/src/observability/`：`platform.agent.turn` 用 per-turn `messages_in.traceparent`；`mcp.classify` / `mcp.erp` TOOL span

---

## References

- 本 plan spec：`.sisyphus/drafts/2026-06-08-observability-business-first-tracing-spec.md`
- ADR-0017：`docs/decisions/ADR-0017-observability-phoenix17-route-type-taxonomy.md`（Phoenix 升级基础，继续有效）
- ADR-0014：`docs/decisions/ADR-0014-observability-span-schema.md`（span naming schema；spec 已合并至 `docs/specs/observability.md`）
- ADR-0015：`docs/decisions/ADR-0015-observability-coverage-gate.md`（coverage gate）
- Phoenix docs：`https://arize.com/docs/phoenix/tracing/concepts-tracing/what-are-traces`
