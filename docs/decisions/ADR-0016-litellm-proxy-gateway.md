# ADR-0016: LiteLLM Proxy Gateway 引入

- **Status**: Accepted
- **Date**: 2026-06-01
- **Decider(s)**: 用户（项目负责人）；coding agent（提案 / 执行）
- **Tags**: `observability`, `phase0b`, `provider`, `infra`, `litellm`
- **Supersedes**: —
- **Superseded by**: —

---

## Context

[ADR-0011](ADR-0011-host-otel-instrumentation.md) 记录了 host-side OTel instrumentation（PR-O2），并在 Container Propagation 一节明确标注 PR-O3（container-side propagation）为 pending。

当前状态存在三个相互关联的缺口：

1. **容器 OTel 零覆盖**：`container/agent-runner/` 没有任何 `@opentelemetry/*` 依赖。`OTEL_TRACEPARENT` 已由 host 注入容器环境变量，但容器侧完全忽略它，trace tree 在 host 边界处断裂。

2. **LLM 数据黑洞**：容器通过 `outbound.db` 的 `llm-usage` 行向 host 传递 token/cost/latency 数据，但 `src/delivery.ts` 在 drain 阶段将这些行丢弃，数据从未进入 Phoenix。Phoenix Sessions 里没有任何 `openinference.span.kind=LLM` 的 span，无法做 LLM 级别的成本追踪或延迟分析。

3. **无模型路由能力**：当前 provider 直连 OpenAI，没有 fallback、限流、或多模型路由层。

LiteLLM Proxy 是一个开源 Python 服务，提供 OpenAI-compatible HTTP 接口，内置 `arize_phoenix` callback，可以自动产出符合 OpenInference 语义的 LLM span，直接发往 Phoenix OTLP 端点。引入它可以同时解决上述三个问题，并为 PR-O3 提供一条最小化的落地路径。

已知约束：

- ADR-0007 锁定 Phoenix OSS + Grafana 为唯一 sanctioned observability 栈，不能引入 Logfire / Langfuse 等替代方案。
- ADR-0009 定义了 observability compose stack 的 bootstrap contract（Phoenix + Postgres + Grafana），任何扩展必须显式记录。
- ADR-0011 的 identity 信任链（`RequestIdentity`、`origin_user_id`、HMAC、`erp_audit`）不能被削弱。
- Claude provider 使用 `@anthropic-ai/claude-agent-sdk`，不走标准 HTTP，无法透明代理。

## Options Considered

- **Option A**: LiteLLM Proxy 合并到 observability compose stack（`infra/observability/docker-compose.prod.yml`）。优点：Docker 内网通信，LiteLLM 可直接用 Docker DNS `http://phoenix:6006/v1/traces` 发 OTLP，一个 `pnpm obs:up` 启动全部服务，运维最简单。缺点：扩展了 ADR-0009 的 observability stack 契约，需要本 ADR 显式记录。工作量：低。

- **Option B**: LiteLLM Proxy 独立 compose stack（`muap-litellm`）。优点：独立生命周期，不改 ADR-0009 的 compose 文件。缺点：LiteLLM 需要通过 `host.docker.internal` 跨网络访问 Phoenix，多一个 compose 文件需要单独管理，`pnpm obs:up` 不能一键启动全部。工作量：低，但运维复杂度略高。

- **Option C**: 不引入 LiteLLM，手动在容器内添加 OTel span 并自行采集 token/cost 数据。优点：无新依赖，不引入 Python 运行时。缺点：需要自己实现 GenAI span 属性采集（`gen_ai.usage.input_tokens`、`gen_ai.cost.*` 等），无模型路由 / fallback / 限流能力，长期维护成本高，且无法复用 LiteLLM 已有的 OpenInference 集成。工作量：高。

## Decision

> **拍板**：选 Option A — LiteLLM Proxy 合并到 observability compose stack。

核心理由：

1. LiteLLM 的核心价值是产出 trace（`arize_phoenix` callback），本质上是可观测性基础设施，与 Phoenix + Grafana 同属一个关注层，合并在同一 compose stack 语义上一致。
2. 合并后 LiteLLM 可直接用 Docker DNS `http://phoenix:6006/v1/traces` 发 OTLP，零额外网络配置，避免 Option B 的跨网络复杂度。
3. 当前流量 1-50 并发，LiteLLM Proxy 资源开销无关紧要（约 300MB RSS），不影响 host 或容器资源预算。
4. 一个 `pnpm obs:up` 启动 Phoenix + Grafana + LiteLLM，运维路径与现有习惯一致。
5. ADR-0009 的 observability stack 契约从 "Phoenix + Postgres + Grafana" 扩展为 "Phoenix + Postgres + Grafana + LiteLLM"，本 ADR 即为该扩展的正式记录，符合 CLAUDE.md 的 ADR 强制要求。

附加决策（同次落地）：

- **Provider 范围**：仅 `openai` / `sdk-openai` / `codex` provider 经过 LiteLLM Proxy；`claude` provider 保持原样，Claude Code SDK 不走标准 HTTP，不做代理。
- **容器 OTel 最小化**：PR-O3 采用最小化方案，仅做 trace propagation + `traceparent` header 注入，不做 full auto-instrumentation，避免容器依赖膨胀。
- **向后兼容**：不设 `OPENAI_BASE_URL` 指向 proxy 时，系统照常直连 OpenAI，不破坏现有部署。
- **移除 llm-usage 数据通道**：现有 `outbound.db` 的 `llm-usage` 行传递机制被 LiteLLM 的 GenAI span 属性完全替代，可以移除，消除数据黑洞。
- **新增业务标签**：在 `router.deliver_to_agent` span 上新增 `routing_path`、`engage_mode`、`session_mode` 属性，用于 Phoenix 过滤和 Dataset 创建。

## Consequences

- **Positive**: LLM 级别可观测性统一落地，token/cost/latency 自动出现在 Phoenix trace（`gen_ai.usage.*`、`gen_ai.cost.*`）；PR-O3 补齐，trace tree 从 Host 延伸到 Container 再到 LiteLLM；模型路由 / fallback / 限流能力就绪；成本追踪开箱即用；`llm-usage` 数据黑洞消除。
- **Negative**: observability compose stack 新增一个 service（LiteLLM 约 300MB RSS）；引入 Python 运行时依赖（容器化，不影响主机 Node 环境）；LiteLLM Proxy 宕机时经过 proxy 的 LLM provider 不可用，需要健康检查 + 回退策略。
- **Neutral / Trade-offs**: LiteLLM 的 Responses API streaming 有已知 bug（issue #20975，SSE lifecycle events 处理异常），但本项目使用 `stream: false`，不受影响；`claude` provider 不经过 proxy，其 LLM span 仍需未来单独处理；ADR-0009 的 compose 契约扩展，但 Phoenix / Grafana 的端口、镜像 pin、Grafana provisioning 规则均不变。

## Implementation Notes

落地文件：

```text
infra/observability/docker-compose.prod.yml     — 新增 litellm service
infra/litellm/config.yaml                       — LiteLLM 配置（model_list + arize_phoenix callback）
container/agent-runner/src/observability/init.ts        — 容器 OTel 初始化
container/agent-runner/src/observability/propagate.ts   — traceparent 注入 helper
container/agent-runner/src/providers/openai.ts          — fetch headers 添加 traceparent
container/agent-runner/package.json             — 新增 @opentelemetry/* 依赖
src/router.ts                                   — 新增业务标签属性
docs/observability-span-schema.md               — 新增 §5b.7 LiteLLM span layer + §5b.8 Container OTel spans
docs/decisions/ADR-0016-litellm-proxy-gateway.md
docs/decisions/README.md
```

依赖 ADR：

- ADR-0009：Observability Bootstrap Contract（compose stack 契约扩展基础）
- ADR-0011：Host OpenTelemetry Instrumentation（`OTEL_TRACEPARENT` 注入约定）
- ADR-0014：Observability Span Naming Schema（LiteLLM span 命名需符合 schema v1.0）

验收点：

```bash
pnpm typecheck   # zero errors
pnpm test        # all pass
pnpm obs:up      # Phoenix + Grafana + LiteLLM 全部健康
```

Phoenix trace tree 验收：发送一条消息后，Phoenix 中可见完整 `Host → Container → LiteLLM` 链路，且 LLM span 携带 `gen_ai.usage.input_tokens`、`gen_ai.usage.output_tokens`、`openinference.span.kind=LLM` 属性。

## References

- [ADR-0009: Observability Bootstrap Contract](ADR-0009-observability-bootstrap-contract.md)
- [ADR-0011: Host OpenTelemetry Instrumentation](ADR-0011-host-otel-instrumentation.md)
- [ADR-0014: Observability Span Naming Schema](ADR-0014-observability-span-schema.md)
- LiteLLM Proxy 文档：https://docs.litellm.ai/docs/proxy
- LiteLLM Phoenix 集成：https://docs.litellm.ai/docs/proxy/logging#arize-phoenix
- OpenInference semantic conventions：https://github.com/Arize-ai/openinference
- GitHub Issue #20975：LiteLLM Responses API SSE lifecycle events bug（`stream: false` 不受影响）
