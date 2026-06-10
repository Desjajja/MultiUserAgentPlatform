# MUAP 业务标签 Schema（v1.2）

> **用途**：为 Arize Phoenix 提供可按业务维度过滤的 trace/span 元数据
> **适用范围**：所有 host-side 和 container-side observability spans
> **命名空间**：`muap.*`（MUAP 自定义命名空间，与 OpenInference 标准命名空间隔离）

---

## 1. 分层架构（Layer Separation）

### 1.1 AI 语义层（AI Semantic Layer）

面向模型分析、prompt 调试、工具使用统计。

| Span | OpenInference Kind | 说明 |
|---|---|---|
| `router.deliver_to_agent` | `AGENT` | 用户一次交互的入口，包含 input/output |
| `agent.turn` | `CHAIN` | 容器内一次推理周期（prompt → LLM → tool → output） |
| LiteLLM auto-spans | `LLM` / `TOOL` / `PROMPT` | 由 LiteLLM Proxy 自动生成 |

**标签**：`muap.layer = 'ai'`

### 1.2 平台遥测层（Platform Telemetry Layer）

面向平台工程、容器生命周期、消息投递延迟调试。

| Span | OpenInference Kind | 说明 |
|---|---|---|
| `channel.cli.receive` | `CHAIN` | CLI 通道消息接收 |
| `channel.feishu.receive` | `CHAIN` | 飞书通道消息接收 |
| `router.route` | `CHAIN` | 消息路由决策 |
| `container.wake` | `CHAIN` | 容器唤醒 |
| `container.spawn` | `CHAIN` | 容器创建 |
| `container.kill` | `CHAIN` | 容器终止 |
| `delivery.session.drain` | `CHAIN` | 会话消息批量消费 |
| `delivery.message.deliver` | `CHAIN` | 单条消息投递 |
| `delivery.channel.send` | `CHAIN` | 通道消息发送（含 output.value） |

**标签**：`muap.layer = 'platform'`

---

## 2. 业务标签注册表（Business Tag Registry）

所有标签键以 `muap.` 为前缀，存储于 span attributes JSONB 中。

### 2.1 核心标签（所有 span 必须携带）

| 标签键 | 类型 | 必填 | 合法值 | 说明 |
|---|---|---|---|---|
| `muap.layer` | string | ✅ | `ai` / `platform` | 区分 AI 语义与平台遥测 |

### 2.2 路由标签（Routing Spans）

| 标签键 | 类型 | 必填 | 合法值 | 说明 |
|---|---|---|---|---|
| `muap.route_type` | string | ✅ | `frontdesk` / `worker` / `a2a` / `system` | 路由类型 |
| `muap.lane` | string | ✅ | `frontdesk` / `worker` | 业务车道 |
| `muap.channel` | string | ✅ | `cli` / `feishu` / `webhook` / `unknown` | 入口渠道 |
| `muap.intent` | string | ✅ | `chat` / `approval` / `execute` / `system` | 用户意图 |

### 2.3 会话标签（Session Spans）

| 标签键 | 类型 | 必填 | 合法值 | 说明 |
|---|---|---|---|---|
| `muap.agent_group` | string | ✅ | 任意 | Agent Group 名称，如 `Demo` |
| `muap.session_mode` | string | ✅ | 任意 | 会话模式，如 `shared` / `per-user` |
| `muap.engage_mode` | string | ✅ | `direct` / `a2a` | 交互模式 |

### 2.4 提供者标签（Provider Spans）

| 标签键 | 类型 | 必填 | 合法值 | 说明 |
|---|---|---|---|---|
| `muap.provider` | string | 条件 | `claude` / `openai` / `sdk-openai` / ... | AI 模型提供者 |

---

## 3. 标签设置位置（Setting Locations）

```
router.deliver_to_agent (AGENT)
  muap.layer = 'ai'
  muap.route_type = 'frontdesk'
  muap.lane = 'frontdesk'
  muap.channel = 'cli' | 'feishu'
  muap.intent = 'chat'
  muap.agent_group = 'Demo'
  muap.session_mode = 'shared'
  muap.engage_mode = 'direct' | 'a2a'

agent.turn (CHAIN, container-side)
  muap.layer = 'ai'
  muap.route_type = 'worker'
  muap.lane = 'worker'
  muap.provider = 'sdk-openai' | 'claude'
  muap.agent_group = 'Demo'
  muap.session_mode = 'shared'

container.wake | container.spawn | container.kill
  muap.layer = 'platform'
  muap.route_type = 'worker'
  muap.lane = 'worker'
  muap.provider = 'sdk-openai' (仅 spawn)

delivery.session.drain | delivery.message.deliver | delivery.channel.send
  muap.layer = 'platform'
  muap.route_type = 'worker'
  muap.lane = 'worker'

channel.cli.receive | channel.feishu.receive
  muap.layer = 'platform'
  muap.route_type = 'frontdesk'
  muap.lane = 'frontdesk'
  muap.channel = 'cli' | 'feishu'

router.route
  muap.layer = 'platform'
  muap.route_type = 'frontdesk'
  muap.lane = 'frontdesk'
  muap.channel = event.channelType
```

---

## 4. Phoenix 过滤语法参考

### 4.1 UI Filter Bar（Spans 标签页）

使用 Python 布尔表达式，支持 `attributes["key"].as_string()` 语法：

```text
# 按 layer 过滤
attributes["muap.layer"].as_string() == "ai"

# 按路由类型过滤
attributes["muap.route_type"].as_string() == "frontdesk"

# 按业务车道过滤
attributes["muap.lane"].as_string() == "frontdesk"

# 按渠道过滤
attributes["muap.channel"].as_string() == "cli"

# 组合过滤
attributes["muap.layer"].as_string() == "ai" and attributes["muap.route_type"].as_string() == "frontdesk"

# 按 OpenInference kind 过滤（注意：必须大写）
span_kind == "AGENT"
```

**⚠️ 大小写敏感**：`span_kind == 'agent'` 不会返回结果，必须使用 `span_kind == 'AGENT'`。

### 4.2 REST API

```bash
# 按单层标签过滤
GET /v1/spans?attribute=muap.layer:ai

# 多层组合过滤（AND 关系）
GET /v1/spans?attribute=muap.layer:ai&attribute=muap.route_type:frontdesk

# 按 OpenInference kind 过滤
GET /v1/spans?attribute=openinference.span.kind:AGENT
```

### 4.3 Python SDK

```python
from phoenix import Client

client = Client()
spans = client.spans.get_spans(
    project_identifier="default",
    attributes={
        "muap.layer": "ai",
        "muap.route_type": "frontdesk",
    },
)
```

---

## 5. 已知限制

| 限制 | 状态 | 说明 |
|---|---|---|
| UI filter bar 嵌套属性 | ⚠️ 已知 bug | `attributes["muap.route_type"]` 在 UI 中可能崩溃；优先使用 REST API |
| REST API dot-path | ✅ 支持 | `attribute=muap.route_type:frontdesk` 可直接使用 |
| Traces 标签页过滤 | ❌ 仅根 span | Traces 视图只能按根 span 属性过滤；要查子 span 请用 Spans 视图 |
| 列表类型属性 | ❌ 不支持 | `tags: ["a", "b"]` 无法通过简单 filter 匹配 |
| 正则匹配 | ❌ 不支持 | 所有 filter 均为精确匹配 |

---

## 6. 实现状态

| 组件 | 状态 | 说明 |
|---|---|---|
| `muap.layer` | ✅ 已实现 | 所有 host spans 已标记 |
| `muap.route_type` | ✅ 已实现 | 已定义并设置 |
| `muap.lane` | ✅ 已实现 | 已定义并设置 |
| `muap.channel` | ✅ 已实现 | 已定义并设置 |
| `muap.intent` | ✅ 已实现 | 已定义并设置 |
| `muap.agent_group` | ✅ 已有 | 之前已存在 |
| `muap.session_mode` | ✅ 已有 | 之前已存在 |
| `muap.engage_mode` | ✅ 已有 | 之前已存在 |
| `muap.provider` | ✅ 已实现 | container.spawn 上设置 |
| `agent.turn` (container-side) | ⏳ 待实现 | 当前仅文档化，代码未实现 |

---

## 7. 变更历史

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.0 | 2026-05 | 初始 schema：OpenInference span kind、命名空间、trace topology |
| v1.1 | 2026-06 | 加入 LiteLLM Proxy、容器侧 OTel、root span bridge |
| v1.2 | 2026-06-02 | **当前版本**：加入 layer separation、business tag taxonomy、agent.turn span |
