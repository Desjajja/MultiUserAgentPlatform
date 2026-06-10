# LiteLLM Proxy Gateway 接入说明

> **位置**：`docs/litellm-gateway.md`
> **目的**：定义 MUAP 如何通过 LiteLLM Proxy 统一 LLM 可观测性、路由、成本追踪。本文件是 LLM 参考文档（coding agent 必读），不是人类审阅报告。
> **状态**：v1.0（binding · 2026-06-01）
> **依据**：[ADR-0016](decisions/ADR-0016-litellm-proxy-gateway.md)
> **关联**：[`docs/observability-span-schema.md`](./observability-span-schema.md) §5b.7–§5b.8、[`infra/observability/README.md`](../infra/observability/README.md)

---

## 1. 架构概览

```text
┌─────────────────────────────────────────────────────────────────┐
│  Host (Node.js)                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ router.deliver_to_agent (root span, kind=AGENT)          │   │
│  │   └─ delivery.session.drain                              │   │
│  │       └─ delivery.message.deliver                        │   │
│  │           └─ delivery.channel.send                       │   │
│  └──────────────────────────────────────────────────────────┘   │
│       │ OTEL_TRACEPARENT (env inject)                           │
│       ▼                                                         │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Container (agent-runner)                                  │   │
│  │   OTel init → read OTEL_TRACEPARENT → child context       │   │
│  │   ┌────────────────────────────────────────────────────┐  │   │
│  │   │ agent.turn (span, kind=CHAIN)                      │  │   │
│  │   │   └─ HTTP fetch → LiteLLM Proxy                    │  │   │
│  │   │       (traceparent header injected)                 │  │   │
│  │   └────────────────────────────────────────────────────┘  │   │
│  └──────────────────────────────────────────────────────────┘   │
│       │ traceparent header                                      │
│       ▼                                                         │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ LiteLLM Proxy (Python, Docker)                            │   │
│  │   arize_phoenix callback → OTLP → Phoenix                 │   │
│  │   Spans: Received Proxy Server Request → litellm_request   │   │
│  │          → raw_gen_ai_request                              │   │
│  │   Attributes: gen_ai.usage.*, gen_ai.cost.*, gen_ai.request│   │
│  └──────────────────────────────────────────────────────────┘   │
│       │ OTLP (Docker DNS: http://phoenix:6006/v1/traces)        │
│       ▼                                                         │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Phoenix (trace storage + UI)                              │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## 2. 部署拓扑

LiteLLM Proxy 作为 service 并入 `infra/observability/docker-compose.prod.yml`。

### 2.1 Docker Compose 配置

```yaml
# infra/observability/docker-compose.prod.yml (新增 service)
litellm:
  image: ghcr.io/berriai/litellm:main-v1.72.5.dev1
  depends_on:
    - phoenix
  ports:
    - "${LITELLM_HOST_PORT:-4000}:4000"
  environment:
    LITELLM_MASTER_KEY: ${LITELLM_MASTER_KEY:-sk-litellm-local-only}
    LITELLM_LOG_LEVEL: INFO
    # arize_phoenix callback
    PHOENIX_COLLECTOR_ENDPOINT: http://phoenix:6006
    ARIZE_PHOENIX_OTLP_PORT: 6006
  volumes:
    - ../../infra/litellm/config.yaml:/app/config.yaml:ro
  command: ["--config", "/app/config.yaml", "--port", "4000"]
  healthcheck:
    test: ["CMD", "curl", "-f", "http://localhost:4000/health"]
    interval: 30s
    timeout: 10s
    retries: 3
```

### 2.2 LiteLLM 配置文件

```yaml
# infra/litellm/config.yaml
model_list:
  - model_name: "gpt-4.1"
    litellm_params:
      model: "openai/gpt-4.1"
      api_key: "os.environ/OPENAI_API_KEY"
      # api_base 不设 → 直连 OpenAI

  - model_name: "gpt-4.1-mini"
    litellm_params:
      model: "openai/gpt-4.1-mini"
      api_key: "os.environ/OPENAI_API_KEY"

  - model_name: "gpt-4.1-nano"
    litellm_params:
      model: "openai/gpt-4.1-nano"
      api_key: "os.environ/OPENAI_API_KEY"

  # 兼容 d1token 等 OpenAI-compatible 代理
  - model_name: "d1token/*"
    litellm_params:
      model: "openai/*"
      api_key: "os.environ/D1TOKEN_API_KEY"
      api_base: "os.environ/D1TOKEN_BASE_URL"

litellm_settings:
  # W3C traceparent propagation
  enable_traceparent_in_header: true
  # Phoenix callback
  success_callback: ["arize_phoenix"]
  failure_callback: ["arize_phoenix"]
  # 不缓存（保持简单）
  cache: false

general_settings:
  master_key: "os.environ/LITELLM_MASTER_KEY"
```

### 2.3 端口分配

| 服务 | Host Port | Container Port | 用途 |
|---|---|---|---|
| LiteLLM Proxy | `4000` | `4000` | OpenAI-compatible API endpoint |
| Phoenix | `6006` | `6006` | OTLP HTTP + Web UI |
| Grafana | `3001` | `3000` | Dashboards |

### 2.4 网络通信路径

| 源 | 目标 | 地址 | 协议 |
|---|---|---|---|
| agent-runner (容器) | LiteLLM Proxy | `host.docker.internal:4000` | HTTP (OpenAI API) |
| LiteLLM Proxy | Phoenix | `http://phoenix:6006/v1/traces` | OTLP HTTP/Protobuf |
| LiteLLM Proxy | OpenAI / 第三方 | 公网 | HTTPS |
| Host (Node.js) | Phoenix | `http://localhost:6006/v1/traces` | OTLP HTTP/Protobuf |

---

## 3. 容器侧 OTel 接入 (PR-O3)

### 3.1 依赖

```json
// container/agent-runner/package.json (新增)
{
  "@opentelemetry/api": "^1.9.0",
  "@opentelemetry/core": "^1.30.0",
  "@opentelemetry/sdk-trace-node": "^1.30.0",
  "@opentelemetry/exporter-trace-otlp-http": "^0.57.0",
  "@opentelemetry/resources": "^1.30.0",
  "@opentelemetry/semantic-conventions": "^1.30.0"
}
```

### 3.2 初始化 + Traceparent 传播

单文件实现（`container/agent-runner/src/observability/init.ts`）：

```typescript
import { NodeTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { type Context, context, propagation, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';

let parentContext: Context = ROOT_CONTEXT;

export function initContainerOTel(sessionId: string): void {
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());

  const provider = new NodeTracerProvider({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: `agent-runner-${sessionId.slice(0, 8)}`,
    }),
  });

  const endpoint =
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
    'http://host.docker.internal:6006/v1/traces';

  provider.addSpanProcessor(new SimpleSpanProcessor(new OTLPTraceExporter({ url: endpoint })));
  provider.register();

  const traceparent = process.env.OTEL_TRACEPARENT;
  if (traceparent) {
    parentContext = propagation.extract(ROOT_CONTEXT, { traceparent });
  }
}

export function injectTraceparent(headers: Record<string, string>): Record<string, string> {
  const carrier: Record<string, string> = { ...headers };
  propagation.inject(parentContext, carrier);
  return carrier;
}
```

关键设计：
- `OTEL_TRACEPARENT` 由 host 在 `wakeContainer()` 时注入容器 env
- 提取后存为 module-level `parentContext`，所有出站 HTTP 请求从中注入 traceparent
- 不创建容器级 root span（避免资源泄漏），仅做 context propagation

### 3.3 Provider 集成点

仅 `openai.ts` 和 `sdk-openai.ts` 需要改动：

```typescript
import { injectTraceparent } from '../observability/init.js';

// openai.ts — fetch 调用
const headers = injectTraceparent({
  'content-type': 'application/json',
  authorization: `Bearer ${apiKey}`,
});
```

`claude.ts` **不经过 LiteLLM**（Claude Code SDK 使用自有传输层）。

---

## 4. 主机侧配置

### 4.1 环境变量

```bash
# .env.local (新增 / 修改)
OPENAI_BASE_URL=http://localhost:4000   # 指向 LiteLLM Proxy（可选，不设则直连 OpenAI）
LITELLM_MASTER_KEY=sk-litellm-local-only
LITELLM_HOST_PORT=4000

# 容器注入（已有，无需改动）
# OTEL_TRACEPARENT — 由 host container-runner.ts 自动注入
```

### 4.2 向后兼容

- 不设 `OPENAI_BASE_URL` 或设为 OpenAI 官方地址 → 系统照常直连，LiteLLM 不参与
- LiteLLM Proxy 宕机 → 容器 fetch 失败 → provider 返回错误 → host 正常处理 error path
- 建议生产环境配置 healthcheck + 回退策略

### 4.3 业务标签注入

在 `src/router.ts` 的 `router.deliver_to_agent` root span 上新增 metadata attributes：

```typescript
// src/router.ts — deliverToAgent() 内
rootSpan.setAttributes({
  'muap.routing_path': routingPath,        // e.g. "frontdesk→worker"
  'muap.engage_mode': engageMode,          // e.g. "direct", "a2a"
  'muap.session_mode': sessionMode,        // e.g. "per-user", "shared"
  'muap.agent_group': agentGroup.name,     // e.g. "frontlane-template-frontdesk"
  // Phoenix 可按这些 metadata 过滤 spans → 创建 Dataset → 运行 Experiments
});
```

---

## 5. 移除旧 llm-usage 数据通道

LiteLLM 的 `arize_phoenix` callback 自动产出 GenAI 语义 span（含 `gen_ai.usage.*`、`gen_ai.cost.*`），完全替代旧的 `llm-usage` outbound.db 行。

### 5.1 待删除代码

| 文件 | 删除内容 |
|---|---|
| `container/agent-runner/src/providers/openai.ts` | `emitUsage()` / usage 写入 outbound.db 的逻辑 |
| `container/agent-runner/src/providers/sdk-openai.ts` | usage emit 相关代码 |
| `container/agent-runner/src/poll-loop.ts` | `llm-usage` 类型的 outbound 写入 |
| `src/delivery.ts` | `llm-usage.skipped` span event + 相关 drain 逻辑 |

### 5.2 保留内容

- `delivery.session.drain` span 本身保留（它承载 delivery lifecycle）
- provider error metrics / span events 保留（平台级编排可观测性）
- `outbound.db` 的其他行类型（`send_message` 等）不受影响

---

## 6. Trace Tree 完整示例

LiteLLM 接入后，一次完整的用户请求 trace tree：

```
router.deliver_to_agent (kind=AGENT, service=muap-host)
  ├─ container.wake (kind=CHAIN)
  ├─ delivery.session.drain (kind=CHAIN)
  │   ├─ delivery.message.deliver (kind=CHAIN)
  │   │   └─ delivery.channel.send (kind=CHAIN)
  │   └─ [no more llm-usage.skipped events]
  └─ agent.turn (kind=CHAIN, service=agent-runner-{prefix})  ← 容器侧
      └─ Received Proxy Server Request (kind=SERVER, service=litellm-proxy)  ← LiteLLM
          └─ litellm_request (kind=INTERNAL)
              └─ raw_gen_ai_request (kind=INTERNAL)
                  attributes:
                    gen_ai.usage.input_tokens: 1234
                    gen_ai.usage.output_tokens: 567
                    gen_ai.cost.total: 0.0089
                    gen_ai.request.model: gpt-4.1
                    gen_ai.response.model: gpt-4.1-2026-04-14
```

---

## 7. 运维命令

```bash
# 启动全栈（Phoenix + Postgres + Grafana + LiteLLM）
pnpm obs:up

# 检查 LiteLLM 健康
curl http://localhost:4000/health

# 查看 LiteLLM 日志
docker compose -p muap-observability-prod logs litellm -f

# 列出已注册模型
curl -H "Authorization: Bearer sk-litellm-local-only" http://localhost:4000/v1/models
```

---

## 8. 安全注意事项

- `LITELLM_MASTER_KEY` 是 LiteLLM Proxy 的 API key，**不要**暴露到公网
- LiteLLM Proxy 不向公网暴露（仅 host 网络 + Docker 内网）
- `OPENAI_API_KEY` 等上游 key 通过 env 注入 LiteLLM 容器，不写入 config.yaml
- agent-runner 容器通过 `host.docker.internal:4000` 访问 proxy，不需要额外鉴权（同机通信）
  - 生产环境如需鉴权：在 container env 注入 `LITELLM_API_KEY`，provider fetch 带 `Authorization: Bearer ${LITELLM_API_KEY}`

---

## 9. 已知限制

| 限制 | 影响 | 缓解 |
|---|---|---|
| LiteLLM Responses API streaming SSE bug (#20975) | 不影响（我们用 `stream: false`） | 监控 LiteLLM release notes |
| Claude provider 不经过 LiteLLM | Claude 调用无 GenAI span | 未来可考虑 manual span 或 Claude SDK hook |
| LiteLLM Proxy 单点 | Proxy 宕机 = LLM 不可用 | healthcheck + 容器 restart policy + 可选 direct fallback |
| 容器 OTel 仅 trace（无 metrics/logs） | 容器级 metrics 仍走 host Prometheus | 足够当前阶段需求 |

---

## 10. References

- [ADR-0016](decisions/ADR-0016-litellm-proxy-gateway.md) — 本方案的架构决策记录
- [ADR-0011](decisions/ADR-0011-host-otel-instrumentation.md) — Host OTel instrumentation
- [`docs/observability-span-schema.md`](./observability-span-schema.md) §5b.7–§5b.8 — LiteLLM + Container span 规范
- [`infra/observability/README.md`](../infra/observability/README.md) — Observability stack 运维手册
- LiteLLM Proxy docs: https://docs.litellm.ai/docs/proxy
- LiteLLM Phoenix callback: https://docs.litellm.ai/docs/proxy/logging#arize-phoenix
- OpenTelemetry JS SDK: https://opentelemetry.io/docs/languages/js/
- W3C Trace Context: https://www.w3.org/TR/trace-context/
