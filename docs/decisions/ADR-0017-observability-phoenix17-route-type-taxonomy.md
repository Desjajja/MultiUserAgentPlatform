# ADR-0017: Observability Phoenix 17.2.0 升级 + 业务过滤维度迁移到 OpenInference `metadata` + `route_type` taxonomy 重构

- **Status**: Accepted（Phoenix 17.2.0 升级部分继续有效；`route_type` 作为首选业务过滤维度已被 ADR-0018 超越）
- **Date**: 2026-06-07
- **Decider(s)**: 用户（拍板）；coding agent（提案 + 调研 + 执行）
- **Tags**: `observability`, `phase0b`, `tracing`, `phoenix`, `schema-governance`
- **Supersedes**: —（不撤销既有 ADR；对 ADR-0009 的 Phoenix 镜像 pin 与 ADR-0014 的业务标签承载方式做追加修订，见下）
- **Superseded by**: ADR-0018 supersedes the `route_type`-as-primary-business-filter design and route taxonomy; Phoenix 17.2.0 upgrade and `metadata` encoding decisions remain fully Accepted.

---

## Context

Phase 0b observability 落地后（ADR-0011 host OTel、ADR-0014 span schema、ADR-0015 coverage gate、ADR-0016 LiteLLM proxy），出现三个相互耦合的问题，必须一次性解决：

1. **Phoenix 版本过旧**：prod/sim compose 仍 pin `arizephoenix/phoenix:version-8.0.0`。8.0.0 的过滤能力受限——REST API 不支持 `attribute=key:value`（需 ≥14.9.0），UI filter bar 对自定义命名空间只能用嵌套方括号 `attributes["muap"]["layer"]`，体验与可发现性差。

2. **业务过滤维度承载方式不可用于 UI**：现有业务标签用 flat `muap.*` OTel attribute key（`src/observability/business-tags.ts`）。实测 Phoenix 图形化过滤界面中 **`attributes` 不是合法过滤字段**，因此 `muap.*` 无法在 UI 直接过滤；而 `metadata` 在 Phoenix 中是**一等公民过滤字段**（官方文档示例 `metadata["topic"] == 'programming'`，并明示 "Any expressions that work with the `.where()` method can also be used in the UI"）。用户明确偏好 `metadata`。

3. **`route_type` 语义与运行时不符**：
   - `RouteType.A2A` 把"跨 agent 派活"误当成一种路由类型，与 `engage_mode` 语义重叠。
   - container 侧 `agent.turn` hardcode `muap.route_type='worker'`（`container/agent-runner/src/observability/turn-span.ts`），frontdesk 容器回合被错误标成 worker。
   - 隐藏 bug：container `index.ts` 读 `FRONTLANE_SESSION_ID`，但 host `src/container-runner.ts` 从未注入，导致 `agent.turn` 的 `session.id='unknown'`。

Known constraints（决策时已知约束）：
- host 已安装 `@arizeai/openinference-core@2.2.0`（导出 `getMetadataAttributes`）+ `@arizeai/openinference-semantic-conventions`（导出 `METADATA`）。
- container（`container/agent-runner/`）**无** `@arizeai` 依赖，且应避免镜像/依赖膨胀。
- 本项目业务 span 全部用裸 `@opentelemetry/api` 的 `tracer.startSpan()` / `startActiveSpan()` 手写。
- Phoenix 启动会自动迁移 Postgres schema，升级不可在 prod-in-place 直接演练。

## Options Considered

### 过滤维度承载（核心分歧点）

- **Option A：保留 flat `muap.*` attribute keys**。优点：零运行时改动。缺点：UI 不能过滤（`attributes` 非合法过滤字段），违背用户真实需求；已被实测否决。
- **Option B：迁移到 OpenInference `metadata` 命名空间**（单个 `metadata` JSON attribute）。优点：UI/REST/SQL 三路均可过滤，符合 Phoenix 官方推荐与 OpenInference 一等公民地位。缺点：需改 `applyBusinessTags` 内部实现 + container 侧需本地 helper。**选定**。
- **Option C：用 `setMetadata` / `using_metadata` context API**。优点：官方语义化 API。缺点：仅把数据放进 OTel context，需 `OITracer`/auto-instrumentation 在 `startSpan` 时读取；本项目用裸 tracer，context metadata 永远不会落到 span 上。**技术不可行（对本项目手写 span）**。

### `metadata` 的编码方式

- **host**：用 `@arizeai/openinference-core` 的 `getMetadataAttributes(tags)`（产出 `{ metadata: JSON.stringify(...) }`）。**选定**。
- **container**：本地轻量 helper 输出等价 `{ metadata: JSON.stringify(...) }`，不引入 `@arizeai`。**选定**（避免镜像膨胀）。

### `applyBusinessTags` 调用面

- **保持调用方 API 不变**，仅切换底层从 `setAttribute('muap.*')` 到 `setAttributes(getMetadataAttributes(...))`。优点：15 个 host 调用点零改动。**选定**。

### Phoenix 版本

- **Option：`version-17.2.0`**（最新稳定 17.x）。解锁 REST `attribute=` 过滤、UI `metadata[...]` 过滤、更完整查询能力。**选定**。

## Decision

> **拍板**：
> 1. Phoenix 镜像基线从 `version-8.0.0` 升级到 `version-17.2.0`（prod + sim），并加入 17.x 安全硬化 env（`PHOENIX_AGENTS_DISABLE_WEB_ACCESS=true`、`PHOENIX_ALLOW_EXTERNAL_RESOURCES=false`、`PHOENIX_TELEMETRY_ENABLED=false`、`PHOENIX_ALLOWED_PROVIDERS=NONE`）。
> 2. 业务过滤维度从 flat `muap.*` 迁移到 OpenInference **`metadata`** 命名空间。host 用 `getMetadataAttributes`，container 用等价本地 helper。`applyBusinessTags` 调用面保持不变。
> 3. `RouteType` taxonomy 重构：删除 `A2A`，新增 `ERP`（reserved，暂不发射）；`a2a` 语义只由 `engage_mode='a2a'` 承载。`route_type` 绑定到内容相关 span（`router.deliver_to_agent` / `agent.turn`），反映真实 lane。
> 4. host→container route context 通过 `FRONTLANE_ROUTE_TYPE` + `FRONTLANE_SESSION_ID` env 注入传播，顺带修复 `agent.turn` 的 `session.id='unknown'`。

核心理由（可验证）：
- `metadata` 是 Phoenix UI 唯一可用的业务维度过滤承载（实测 + 官方文档双重确认）。
- `setMetadata` 对裸 tracer 不生效，已在本地 `node_modules` 验证 `getMetadataAttributes` 才是正确机制。
- `route_type` 与 `engage_mode` 解耦后，过滤"frontdesk 实际回复内容"语义正确。

## Consequences

- **Positive**：
  - UI / REST / SQL 三路过滤统一：`metadata["route_type"] == "frontdesk"` / `attribute=metadata.route_type:frontdesk` / `attributes->'metadata'->>'route_type'`。
  - frontdesk 容器回合不再伪装成 worker；`agent.turn` 带真实 `session.id`。
  - 解锁 Phoenix 17.x 高级过滤/查询能力。
  - 调用面不变 → 15 个 host emitter 零改动。
- **Negative**：
  - 引入"单个 `metadata` JSON attribute"的合并风险：同一 span 多次 `applyBusinessTags` 必须 union 而非覆盖，需 staging 验证。
  - container 侧多一个本地 helper（轻量，可接受）。
  - 保留期重叠：旧 trace 仍含 flat `muap.route_type='a2a'`，直到 `PHOENIX_DEFAULT_RETENTION_POLICY_DAYS=7` 过期；跨新旧数据查询需分别处理。
- **Neutral / Trade-offs**：
  - 暂不采用官方 `OITracer` / `withSpan` / LLM auto-instrumentation（列为 future work）。若未来迁移到 `OITracer`，本 ADR 的 "setMetadata 不可行" 前提需重审。
  - `RouteType.ERP` 先 reserved；若未来出现真实 ERP span，需显式 override，而非启发式推断。

## Implementation Notes

- 落地文件：
  - `infra/observability/docker-compose.prod.yml`、`docker-compose.sim.yml`、`.env.example`
  - `src/observability/business-tags.ts`（metadata 迁移 + taxonomy）
  - `src/router.ts`、`src/observability/context-bridge.ts`（裸 setAttribute 收编；`output.value`/`session.id` 保留为 OpenInference 语义字段）
  - `src/container-runner.ts`（`FRONTLANE_*` env 注入 + route-type 派生 helper）
  - `container/agent-runner/src/config.ts`、`index.ts`、`poll-loop.ts`、`observability/turn-span.ts`、新增 `observability/metadata.ts`
  - 文档：`docs/specs/observability.md`（已合并 observability-business-tags.md + observability-span-schema.md + observability-instrumentation-methodology.md）、`infra/observability/README.md`
  - 计划：`docs/superpowers/plans/2026-06-07-muap-observability-metadata-final.md`
- 依赖上游：ADR-0007（Phoenix 唯一后端）、ADR-0009（bootstrap contract / 镜像 pin）、ADR-0014（span schema）、ADR-0016（LiteLLM）。
- 对 ADR-0009 的修订：Phoenix 镜像 pin 由 `8.0.0` 升级为 `17.2.0`；ADR-0009 保持 Accepted（历史 bootstrap 契约不变），镜像 pin supersession 仅在本 ADR 记录。
- 对 ADR-0014 的修订：业务标签承载方式从 flat `muap.*` 改为 `metadata` 命名空间；span 命名 schema 本身不变。
- 验收点：`scripts/observability-bootstrap.test.ts`（17.2.0 pin）、`container/agent-runner/src/integration.test.ts`（`agent.turn` metadata.route_type + session.id）、`scripts/observability-coverage.test.ts`、Manual QA 三重过滤。
- env flag 校正：计划稿原列 `PHOENIX_DISABLE_AGENT_ASSISTANT=true`，经 Phoenix 源码（`src/phoenix/config.py`）核实该变量**不存在**；改用真实变量 `PHOENIX_AGENTS_DISABLE_WEB_ACCESS=true`。其余 3 个（`PHOENIX_ALLOW_EXTERNAL_RESOURCES` / `PHOENIX_TELEMETRY_ENABLED` / `PHOENIX_ALLOWED_PROVIDERS`）已核实为真实变量。
- Oracle review 修正（2026-06-07，编码完成后追加）：
  - **Critical** — `agent.turn` 此前用 `tracer.startSpan(name, opts)` 启动，未传入 host 注入的 `OTEL_TRACEPARENT` 派生上下文，导致 host→container trace 被切断成两棵独立树。修复：`init.ts` 新增 `getParentContext()` 导出，`turn-span.ts` 通过 `tracer.startSpan(name, opts, ctx)` 显式 parent；新增 `container/agent-runner/src/observability/turn-span.test.ts` 用真实 W3C traceparent 断言 `traceId` / `parentSpanId` 与 host 一致。
  - **Important** — `container.wake/spawn/kill` 平台 span 此前 hardcode `route_type='worker'`，frontdesk 容器生命周期被错误标签为 worker。修复：`src/container-runner.ts` 新增 `laneForSession(agentGroupId)` 根据 agent group folder 派生真实 lane（删除组的兜底是 `'system'`）。
  - **Important** — 容器侧 `routeType` 是裸 `string`，手工 `docker run -e FRONTLANE_ROUTE_TYPE=a2a` 仍会写出 `metadata.route_type='a2a'`。修复：`container/agent-runner/src/observability/metadata.ts` 新增 `validateRouteType()`，allowlist 为 `frontdesk|worker|erp|system`；`index.ts` 在读取 env 时调用，未知值回落到 `'worker'` 并 stderr 告警。
  - **Nit** — `FRONTLANE_SESSION_ID` 缺失时静默回落 `'unknown'`，掩盖 host 注入回归。修复：`index.ts` 在 fallback 前打印 `WARNING: ... host did not inject it. Spans will report session.id=unknown.` 让 stderr 暴露问题。
- Manual QA 期间发现额外缺陷（与 Oracle review 不同源）：`src/container-runner.ts` 在 `buildContainerArgs(...)` 返回**之后**才 `args.push('-e', ...)` 注入 `OTEL_TRACEPARENT` / `FRONTLANE_ROUTE_TYPE` / `FRONTLANE_SESSION_ID`，但 `buildContainerArgs` 已在末尾追加 `--entrypoint bash <image> -c "exec bun run /app/src/index.ts"`。docker run 的位置语义里，`<image>` 之后的内容是 entrypoint argv，不是容器 env；结果是这三个 env 全部被静默丢到 bash 的命令行参数列表，**容器内根本看不到**，进而：
  - container `agent.turn` span 没有 host parent context（trace 树断裂，与 Oracle Critical 同源现象但不同根因）
  - `FRONTLANE_ROUTE_TYPE` 默认走 `'worker'` fallback（因 `validateRouteType(undefined) → 'worker'`）
  - `FRONTLANE_SESSION_ID` 触发新加的 stderr 告警 + `session.id='unknown'`
  这是从 ADR-0011 host OTEL bootstrap 起就一直存在的潜伏缺陷，从未被发现是因为之前没人验证容器内是否真的拿到了 `OTEL_TRACEPARENT`。修复：把三段 env 注入收编到 `envFlags: string[]`，再 `args.splice(args.indexOf('--entrypoint'), 0, ...envFlags)` 在 `--entrypoint` 之前插入；找不到 anchor 时显式抛错，避免再次回归到“静默丢 env”。修复后 docker inspect 验证 `Args = ["-c", "exec bun run /app/src/index.ts"]`、`docker exec ... env` 看到三段 env，`agent.turn` span 真正继承 host trace_id。
- Future work（不在本次范围）：Tier 3 官方 `withSpan`/`traceChain`；Tier 4 `OITracer` masking/redaction；LLM auto-instrumentation `@arizeai/openinference-instrumentation-openai`。

## What Remains Accepted vs What Is Superseded (ADR-0018 addendum)

This note was added on 2026-06-09 to clarify the boundary between ADR-0017 and ADR-0018.

**Remains fully Accepted (load-bearing, do not revert):**

- Phoenix image upgraded to `arizephoenix/phoenix:version-17.2.0` — still pinned, still required.
- Business metadata encoded via OpenInference `metadata` namespace using `getMetadataAttributes` (host) and local helper (container) — still required.
- `applyBusinessTags` calling convention unchanged — still required.
- 17.x security hardening env flags (`PHOENIX_AGENTS_DISABLE_WEB_ACCESS`, `PHOENIX_ALLOW_EXTERNAL_RESOURCES`, `PHOENIX_TELEMETRY_ENABLED`, `PHOENIX_ALLOWED_PROVIDERS`) — still required.
- `FRONTLANE_ROUTE_TYPE` / `FRONTLANE_SESSION_ID` env injection into containers, and `OTEL_TRACEPARENT` placement fix — still required.
- `validateRouteType()` allowlist in container metadata helper — still required.

**Superseded by ADR-0018 (do not use as the primary design):**

- `metadata.route_type` as the **primary** business filter dimension. The correct primary filter is now `metadata["span_scope"] == "business"` and span name filters like `name == "interaction.frontdesk"`.
- The route-type-first span taxonomy: `router.deliver_to_agent` as the Session root, `router.route` as a business-carrying span, and platform spans tagged with `route_type`.
- `metadata.layer = 'ai' | 'platform'` as the primary layer separation field. Superseded by `metadata.span_scope = 'business' | 'platform' | 'tool' | 'routing'`.

**Historical rationale is preserved:** The original context and decision rationale in this ADR remain as documentation of the reasoning that led to ADR-0017. Future agents should read this ADR to understand why Phoenix 17.2.0 was chosen and why `metadata` was adopted; they should read ADR-0018 to understand why `interaction.*` span roots supersede `route_type` filtering.

## References

- Phoenix 官方文档：metadata 过滤（`metadata["topic"] == 'programming'`；".where() 表达式同样可用于 UI"）
- `@arizeai/openinference-core@2.2.0` → `getMetadataAttributes`（`node_modules/@arizeai/openinference-core/dist/src/helpers/attributeHelpers.js`）
- `@arizeai/openinference-semantic-conventions` → `METADATA` 常量
- 计划文档：`docs/superpowers/plans/2026-06-07-muap-observability-metadata-final.md`（终态）、`docs/superpowers/plans/2026-06-07-muap-observability-phoenix17-route-taxonomy.md`（flat-key 旧版，仅供对照）
- 关联 ADR：ADR-0007 / ADR-0009 / ADR-0011 / ADR-0014 / ADR-0015 / ADR-0016
