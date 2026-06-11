# ADR-0020: 模型元数据注册表 + 上下文可见性 + 推理/成本追踪

- **Status**: Accepted
- **Date**: 2026-06-10
- **Decider(s)**: 用户（项目负责人），coding agent（调研 / 提案）
- **Tags**: `observability`, `provider`, `model-registry`, `cost-tracking`, `reasoning`, `context-visibility`, `phoenix`
- **Supersedes**: —
- **Superseded by**: —

---

## Context

### 1.1 触发事件

用户提出三个关联需求：

1. **规范化模型配置**：当前模型配置散落在 `.env`（`OPENAI_MODEL=deepseek-v4-flash`）、`infra/litellm/config.yaml`（模型列表）、`container/agent-runner/src/providers/openai.ts`（硬编码 fallback `DEFAULT_MODEL = 'gpt-5.4'`）中。多模型接入时缺乏统一的 metadata 层。

2. **上下文可见性**：需要确认在 Phoenix 中能否看到“agent 收到了什么上下文”，包括 system prompt、对话历史、token 占用统计。

3. **推理内容 + 成本追踪**：需要捕获 reasoning 模型的中间推理内容（如 DeepSeek reasoning_content）和精细化的成本计算。

### 1.2 已知约束

- **ADR-0007**：锁定 Phoenix OSS + Grafana 为唯一可观测性栈，不能引入 Langfuse / Logfire 等替代方案。
- **ADR-0016**：LiteLLM Proxy 已作为 LLM 网关，通过 `arize_phoenix` callback 自动生成 GenAI spans。`llm-usage` 数据通道已标记为废弃。
- **ADR-0014 / v1.4**：OpenInference span 命名 schema 已锁定，新增属性需符合 schema 约束。
- **OpenInference 限制**：目前不支持 `message.reasoning_content` 字段（官方 PR [#1642](https://github.com/Arize-ai/openinference/pull/1642) 讨论中），Phoenix 无法直接渲染 reasoning content。
- **Phoenix 原生能力**：支持 prompt management（版本、模板、标签），但**不自动追踪**“本次请求实际使用了哪些系统提示词”的组装过程。
- **Claude 特殊路径**：`claude` provider 使用 `@anthropic-ai/claude-agent-sdk`，不经过 LiteLLM Proxy，其 LLM span 需独立处理。

### 1.3 当前状态

| 能力 | 现状 | 缺口 |
|---|---|---|
| 模型配置 | 环境变量 + LiteLLM config 硬编码 | 无统一 metadata registry |
| Token 用量 | LiteLLM GenAI spans 自动捕获 | 无本地预计算 |
| 成本计算 | Phoenix 内置定价表 | 未与 MUAP 配置同步 |
| Reasoning tokens | `llm.token_count.completion_details.reasoning` 支持 | 无 reasoning content 文本 |
| 上下文可见性 | Phoenix 显示 `llm.input_messages` | 不显示 system prompt 组装链路 |
| **Prompt 版本追踪** | Phoenix Prompts 管理 | **未接入 MUAP 运行时 — 高优先级** |

---

## Options Considered

### Option A：配置字引导的 YAML Profile Registry（推荐）

新增 `model-registry/` 目录，通过 `MODEL_PROFILE` 环境变量指向 YAML profile 文件，集中管理模型元数据、定价、能力标记、推理配置。

- **优点**：
  - 配置字机制与现有 `OPENAI_MODEL` 兼容，可渐进迁移
  - 支持多模型分组（`groups.default` / `groups.reasoning`）
  - 定价数据可推送到 Phoenix Settings > Models
  - 向后兼容：无 `MODEL_PROFILE` 时 fallback 到现有 env 变量
- **缺点**：
  - 新增 YAML 解析依赖
  - 需要修改 host + container 两侧的 provider 配置注入
- **工作量**：中等（纯新增模块，不破坏现有）

### Option B：纯环境变量扩展

扩展 `.env` 格式，增加 `MODEL_*` 前缀变量（如 `MODEL_DEEPSEEK_V4_FLASH_INPUT_PRICE=0.10`）。

- **优点**：
  - 无新增文件格式
  - 与现有 `readEnvFile()` 兼容
- **缺点**：
  - 环境变量爆炸，不适合多模型配置
  - 无结构化能力标记（vision/audio/reasoning）
  - 无版本管理
- **工作量**：低
- **否决原因**：不满足“多模型规范化配置”的核心需求

### Option C：Phoenix Prompts 原生方案

使用 Phoenix Prompts API 管理 prompt 模板和版本，作为“模型配置”的替代方案。

- **优点**：
  - Phoenix 原生支持 prompt 版本、标签、playground
  - 可追踪 prompt 变更历史
- **缺点**：
  - Phoenix Prompts 管理的是**prompt 模板**，不是**模型接入配置**（base_url、api_key、定价、能力标记）
  - 无法表示模型级 metadata（max_tokens、context_window、streaming 支持）
  - 需要 Phoenix 实例可用才能读取配置，增加运行时依赖
- **工作量**：中等
- **否决原因**：Phoenix Prompts 的语义域与模型接入配置不匹配，且增加运行时硬依赖

### Option D：ERP Gateway 存储模型配置

将模型配置视为“业务配置”放入 ERP Gateway。

- **优点**：
  - 与现有 ERP 网关集成
  - 支持企业级权限管理
- **缺点**：
  - 模型配置是基础设施层，不是业务层
  - 每次接入新模型需修改 ERP schema，太重
  - 增加 ERP 调用链路延迟
- **工作量**：高
- **否决原因**：违背“基础设施配置不硬编码到业务层”原则，且增加不必要的 ERP 耦合

---

## Decision

> **拍板**：选 Option A — 配置字引导的 YAML Profile Registry。

核心理由：

1. **语义域匹配**：模型接入配置（endpoint、capabilities、pricing、reasoning）天然属于基础设施层，YAML 结构化表达最自然。
2. **渐进兼容**：保留现有 `OPENAI_MODEL` / `OPENAI_BASE_URL` 等变量作为 fallback，已有部署无需立即迁移。
3. **Phoenix 协同**：Profile 中的 `phoenix.model_name_in_phoenix` 和 `cost.pricing` 可用于同步 Phoenix 定价表，解决“Phoenix 内置定价表与 MUAP 模型列表不同步”问题。
4. **多模型就绪**：`groups.*` 分组机制支持前端模型选择、A/B 测试、fallback 链等后续需求。

---

## Consequences

### Positive

- 统一模型配置入口，消除 `.env` + `litellm/config.yaml` + provider 硬编码的三处分散
- 成本计算本地化（基于 profile 定价），不依赖 Phoenix 在线定价表
- 推理内容捕获策略可配置化（`capture_strategy: dual_message_split` / `child_span`）
- 支持模型分组和快速切换（开发/测试/生产环境使用不同 profile）
- **Prompt 版本追踪接入**：通过 Phoenix Prompts API 将系统提示词模板化、版本化、标签化，可追踪每次请求使用的 prompt 版本

### Negative

- 新增 `model-registry/` 目录和 YAML loader 模块，增加维护面
- 定价数据需要手动更新（当模型供应商调整价格时）
- Claude provider 不经过 LiteLLM，其推理内容捕获仍需独立实现

### Neutral / Trade-offs

- **Phoenix Prompts vs Model Registry**：Registry 不替代 Phoenix Prompts；Prompts 仍用于模板管理，Registry 用于模型接入配置。二者互补。
- **Reasoning content 可见性**：当前 OpenInference 不支持 `message.reasoning_content`，必须采用 workaround（双消息拆分）。等 OpenInference PR #1642 落地后可迁移到原生方案。
- **Context 可见性边界**：Phoenix 原生显示 `llm.input_messages`，但**不显示**系统提示词的组装过程（如 `instructions + system prompt + context compaction`）。如需追踪提示词组装链路，需在 MUAP 侧增加自定义 span 属性。

---

## Implementation Notes

### 5.1 新增目录结构

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

### 5.2 Profile Schema 示例

```yaml
# model-registry/profiles/deepseek-v4-flash.yaml
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

### 5.3 上下文可见性实现

Phoenix **原生支持**查看 LLM 上下文：

| 可见性需求 | Phoenix 原生能力 | 是否需要 MUAP 侧补充 |
|---|---|---|
| Input messages | `llm.input_messages` 自动显示 | ❌ 不需要 |
| Output messages | `llm.output_messages` 自动显示 | ❌ 不需要 |
| System prompt | `llm.input_messages.0.message.role == "system"` | ✅ 需确保 `instructions` 被正确传入 |
| Token 统计 | `gen_ai.usage.input_tokens` / `output_tokens` | ❌ 不需要（LiteLLM 自动生成） |
| Prompt 版本 | Phoenix Prompts 管理 | ✅ 可选：`using_prompt_template` 注入 |
| 上下文组装链路 | ❌ 不支持 | ✅ 建议新增 `context.assembly` 自定义 span |

**MUAP 侧补充方案**：

```typescript
// 在 agent.turn span 中新增上下文属性
span.setAttribute('context.system_prompt_id', 'frontlane-template-v1');
span.setAttribute('context.instructions_hash', hash(instructions));
span.setAttribute('context.message_count', messages.length);
span.setAttribute('context.estimated_tokens', estimateTokens(messages));
```

### 5.4 Reasoning Content 捕获

```typescript
// 扩展 ProviderEvent usage 类型
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

当 `capture_reasoning_content: true` 时，采用**双消息拆分 workaround**：

```typescript
const outputMessages = [
  { role: "assistant", content: reasoningContent },  // 推理过程
  { role: "assistant", content: finalAnswer },       // 最终答案
];
```

等 OpenInference PR #1642 落地后，可迁移到原生 `message.reasoning_content`。

### 5.5 成本计算模块

```typescript
// container/agent-runner/src/model-registry/cost.ts
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

### 5.6 配置加载优先级

```
1. MODEL_PROFILE=deepseek-v4-flash
   → 加载 model-registry/profiles/deepseek-v4-flash.yaml
   → 使用该 profile 的全部配置

2. OPENAI_MODEL=deepseek-v4-flash（无 MODEL_PROFILE）
   → 查询 model-registry/index.yaml 的 env_overrides.OPENAI_MODEL 映射
   → 如果映射到 profile，加载 profile
   → 如果没有映射，使用裸字符串（向后兼容）

3. 无环境变量
   → 使用 model-registry/index.yaml 的 default_profile
```

### 5.7 落地文件清单

```
model-registry/
  index.yaml
  profiles/deepseek-v4-flash.yaml
  profiles/gpt-4o.yaml

src/
  model-registry/loader.ts          # YAML 加载 + 解析
  model-registry/resolver.ts        # 配置优先级解析
  model-registry/cost.ts            # 成本计算

container/agent-runner/src/
  model-registry/loader.ts          # 容器侧 loader
  model-registry/cost.ts            # 容器侧成本计算
  providers/openai.ts               # 读取 MODEL_PROFILE
  providers/sdk-openai.ts           # 读取 MODEL_PROFILE
  providers/types.ts                # 扩展 UsageEvent

infra/litellm/
  config.yaml → config.yaml.template  # 改为模板，从 registry 生成
```

### 5.8 依赖 ADR

- [ADR-0007](ADR-0007-observability-phoenix-grafana.md)：Phoenix 为唯一可观测性栈
- [ADR-0016](ADR-0016-litellm-proxy-gateway.md)：LiteLLM Proxy 作为 LLM 网关
- [ADR-0014](ADR-0014-observability-span-schema.md)：OpenInference span 命名 schema（spec 已合并至 `docs/specs/observability.md`）
- [ADR-0018](ADR-0018-observability-business-first-tracing.md)：Business-first tracing 语义

### 5.10 Prompt 版本追踪（高优先级）

Phoenix Prompts 提供原生的 prompt 模板管理、版本控制和标签功能。将 MUAP 的系统提示词接入 Phoenix Prompts，可追踪每次 LLM 调用使用的 prompt 版本，支持 A/B 测试、回滚和审计。

#### 5.10.1 设计原则

- **Registry 不替代 Prompts**：Model Registry 管理模型接入配置，Phoenix Prompts 管理提示词模板。二者互补，不重叠。
- **运行时依赖**：Prompt 版本信息在运行时注入 trace，不阻塞 LLM 调用（如果 Phoenix 不可用，fallback 到本地版本号）。
- **向后兼容**：现有硬编码 `instructions` 继续有效，逐步迁移到 Phoenix Prompts 管理。

#### 5.10.2 目录结构

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

#### 5.10.3 Phoenix Prompt 创建（TypeScript SDK）

```typescript
import { createPrompt, promptVersion } from "@arizeai/phoenix-client/prompts";

// 创建/更新 prompt 版本
await createPrompt({
  name: "frontlane-frontdesk-system",
  description: "FrontLane frontdesk agent 系统提示词",
  version: promptVersion({
    modelProvider: "OPENAI",
    modelName: "deepseek-v4-flash",
    template: [
      { 
        role: "system", 
        content: [{ type: "text", text: "You are FrontLane, a helpful enterprise assistant..." }] 
      },
      { 
        role: "user", 
        content: [{ type: "text", text: "{{user_input}}" }] 
      },
    ],
    templateFormat: "MUSTACHE",
    invocationParameters: { temperature: 0.7 },
  }),
});

// 打标签（生产环境）
// 通过 Phoenix CLI 或 API：
// px prompt tag frontlane-frontdesk-system --version <version_id> --name production
```

#### 5.10.4 运行时注入（OpenInference 上下文）

```typescript
import { using_prompt_template } from "@arizeai/openinference-core";

// 在 agent.turn 中注入 prompt 版本信息
const promptTemplate = await getPromptFromPhoenix("frontlane-frontdesk-system", "production");

with using_prompt_template(
    template=promptTemplate.template,
    variables={"assistant_name": "FrontLane", "enterprise_name": "Acme Corp"},
    version=promptTemplate.versionId,
):
    // 在此范围内的 LLM 调用会自动附加：
    // llm.prompt_template.template = "..."
    // llm.prompt_template.version = "v1.2"
    // llm.prompt_template.variables = "{\"assistant_name\": \"FrontLane\"}"
    response = await openaiClient.chat.completions.create({
        model: profile.endpoint.model_path,
        messages: [
            { role: "system", content: promptTemplate.rendered },
            ...userMessages,
        ],
    });
```

#### 5.10.5 容器侧的 prompt 版本注入

```typescript
// container/agent-runner/src/prompts/loader.ts
interface PromptVersion {
  id: string;
  name: string;
  template: string;
  variables: Record<string, string>;
  version: string;
  tag?: string;
}

export async function resolvePrompt(
  promptName: string, 
  tag: string = "production",
  variables: Record<string, string> = {}
): Promise<{ rendered: string; versionId: string; version: string }> {
  try {
    // 尝试从 Phoenix 获取
    const prompt = await getPromptFromPhoenix(promptName, tag);
    const rendered = prompt.format(variables);
    return { rendered, versionId: prompt.versionId, version: prompt.version };
  } catch {
    // Fallback：从本地 prompts/ 目录加载
    const localPrompt = loadLocalPrompt(promptName, tag);
    return { 
      rendered: localPrompt.render(variables), 
      versionId: localPrompt.hash,
      version: localPrompt.version,
    };
  }
}

// 在 agent.turn span 中注入属性
span.setAttribute('llm.prompt_template.name', promptName);
span.setAttribute('llm.prompt_template.version', versionId);
span.setAttribute('llm.prompt_template.variables', JSON.stringify(variables));
```

#### 5.10.6 追踪维度

| 属性 | 来源 | 用途 |
|---|---|---|
| `llm.prompt_template.name` | Phoenix Prompt identifier | 追踪使用了哪个 prompt |
| `llm.prompt_template.version` | Phoenix Prompt version ID | 追踪具体版本 |
| `llm.prompt_template.variables` | 运行时变量 | 追踪变量值（注意敏感信息脱敏） |
| `llm.prompt_template.tag` | Phoenix Tag（production/staging） | 追踪环境 |

#### 5.10.7 与 Model Registry 的集成

```yaml
# model-registry/profiles/deepseek-v4-flash.yaml
profile:
  id: "deepseek-v4-flash"
  # ...

prompts:
  # 该模型默认使用的 prompt
  default_prompt: "frontlane-frontdesk-system"
  # 该模型支持的 prompt 标签
  supported_tags: ["production", "staging", "experimental"]
```

### 5.11 验收点

1. `pnpm typecheck` 零错误
2. `pnpm test` 全部通过
3. 设置 `MODEL_PROFILE=deepseek-v4-flash` 后，容器启动正常，LLM 调用成功
4. Phoenix trace 中可见 `gen_ai.usage.*` 属性（LiteLLM 自动生成）
5. 新增 `usage` event 包含 `reasoningTokens` 和 `costEstimate`（本地计算）
6. Phoenix 定价表显示 `deepseek-v4-flash` 的自定义定价（如果 `auto_push_pricing: true`）
7. **Prompt 版本追踪**：Phoenix trace 中可见 `llm.prompt_template.name` 和 `llm.prompt_template.version` 属性
8. **Prompt 版本追踪**：Phoenix UI 中可查看 prompt 版本历史，支持标签切换（production/staging）

---

## References

### 架构决策
- [ADR-0007](ADR-0007-observability-phoenix-grafana.md)
- [ADR-0016](ADR-0016-litellm-proxy-gateway.md)
- [ADR-0014](ADR-0014-observability-span-schema.md)（spec 已合并至 `docs/specs/observability.md`）
- [ADR-0018](ADR-0018-observability-business-first-tracing.md)

### Phoenix Prompts 官方文档
- **Prompt 管理概述**：https://arize.com/docs/phoenix/prompt-engineering/how-to-prompts
- **Prompt 版本管理**：https://arize.com/docs/phoenix/prompt-engineering/concepts-prompts/prompts-concepts
- **Prompt 标签（Tag）**：https://arize.com/docs/phoenix/prompt-engineering/how-to-prompts/tag-a-prompt
- **TypeScript SDK - Prompts**：https://arize.com/docs/phoenix/sdk-api-reference/typescript/packages/phoenix-client/prompts
- **Prompt 模板追踪（OpenInference）**：https://arize.com/docs/phoenix/tracing/how-to-tracing/add-metadata/instrumenting-prompt-templates-and-prompt-variables
- **CLI - px prompt get**：https://arize.com/docs/phoenix/sdk-api-reference/typescript/arizeai-phoenix-cli
- **比较 Prompt 版本**：https://arize.com/docs/phoenix/prompt-engineering/tutorial/compare-prompt-versions

### OpenInference 语义规范
- OpenInference PR #1642（reasoning content）：https://github.com/Arize-ai/openinference/pull/1642
- Phoenix Issue #8088（reasoning content UI）：https://github.com/Arize-ai/phoenix/issues/8088
- OpenInference 语义约定：https://arize-ai.github.io/openinference/spec/semantic_conventions.html

### LLM Gateway 集成
- LiteLLM Phoenix 集成：https://docs.litellm.ai/docs/proxy/logging#arize-phoenix
- DeepSeek API 文档（reasoning_content）：https://platform.deepseek.com/api-docs
