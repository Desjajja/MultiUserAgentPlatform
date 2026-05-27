# AI Gateway 接入协议

ERP 系统给 FrontLane 智能体平台开放的"前门"。所有 AI Agent 调 ERP 写
入类操作必走这条路径。本文档同时给两类读者用：

- **FrontLane 后端工程师**：要按本文档实现签名 + 调用流
- **AI Agent 本身**：从 skill 加载本文，理解 operation 路由表怎么用

> **核心立场**：本文档所有"铁律 / 不许"**不是不让 Agent 干活**——恰恰相反，
> Gateway 存在的意义就是让 Agent 能**安全、合规地**主动帮老板 / 财务 /
> 业务员干活。Agent 应该把审批 / 录入 / 查询都做成"飞书卡片一键确认"
> 的体验。规矩只管一件事：**不脱离状态机乱搞**（不跳状态 / 不跳审批 /
> 不跳人审 / 不跳金额 / 不跳通道 / 不跳 drafts）。

---

## 1. 架构定位

```
飞书 IM ↔  FrontLane (multi-agent platform)  ↔  ERP Gateway  ↔  ERP 业务端点
                       ↑                          ↑                  ↑
                       AI/LLM 推理              HMAC 验真          require_role
                                              + dryRun + idem    + RLS + 状态机
```

**两层身份**：
- **HMAC**：验证"是 FrontLane 服务来的"（防伪装服务）
- **JWT**：验证"是哪个员工本人"（飞书 open_id → ERP exchange-token → JWT）

二者**叠加**，缺一不可。

---

## 2. 5 个端点

所有端点前缀 `/api/agent/*`，POST 方法。

### 2.1 `POST /api/agent/describe`

返回当前 employee 能调的 operation 清单（按 roles 过滤）。

**请求**：空 body 即可。

**响应**：
```json
{
  "operations": [
    {
      "name": "query.orders",
      "description": "查询订单列表（按 brand/status 筛）",
      "required_roles": [],
      "supports_dry_run": false,
      "max_batch": null
    },
    ...
  ],
  "total": 19
}
```

### 2.2 `POST /api/agent/authorize`

预校验：当前 employee 能否调某 operation（不真执行）。

**请求**：
```json
{ "operation": "orders.confirm_payment", "payload": {...} }
```

**响应**：
```json
{
  "allowed": true,
  "reason": null,
  "requires_user_confirm": true
}
```

`requires_user_confirm=true` 表示真调时必须带 `X-User-Confirm` header。

### 2.3 `POST /api/agent/execute`（核心）

真正执行。

**请求**：
```json
{
  "operation": "orders.confirm_payment",
  "payload": { "order_id": "ord-xyz" },
  "dryRun": false,                   // true = 试跑（事务里 ROLLBACK）
  "idempotencyKey": "uuid-1234",     // 可选，24h 同 key 返缓存
  "intentId": "feishu-conv-abc"      // 可选，AI 对话会话标识
}
```

**响应（成功）**：
```json
{
  "ok": true,
  "operation": "orders.confirm_payment",
  "dry_run": false,
  "result": { ... 真实业务返回 ... }
}
```

**响应（失败）**：
```json
{
  "ok": false,
  "operation": "orders.confirm_payment",
  "dry_run": false,
  "error": "需要角色之一: boss, finance"
}
```

### 2.4 `POST /api/agent/memory/get` 与 `/upsert`

跨对话 KV 存储，按 employee_id × namespace × key 三维索引。

```json
// upsert
{ "namespace": "prefs", "items": { "theme": "dark", "lang": "zh" } }

// get
{ "namespace": "prefs", "keys": ["theme"] }   // keys 不传则返 namespace 全部
```

---

## 3. 必带的 header

每个 `/api/agent/*` 调用必须同时带这些：

| Header | 含义 | 谁产生 |
|---|---|---|
| `Authorization: Bearer <ERP-JWT>` | 当前员工身份 | FrontLane 先调 `/api/feishu/exchange-token` 拿 |
| `x-frontlane-timestamp` | Unix 秒时间戳 | FrontLane |
| `x-frontlane-nonce` | UUID 随机数（10min 内不可重复） | FrontLane |
| `x-frontlane-signature` | HMAC-SHA256（见 §4） | FrontLane |
| `x-channel: ai-agent`（推荐）| 让 audit_logs.actor_kind=ai_agent_assisted | FrontLane（也可以省，Gateway 默认按 AI 处理）|
| `x-intent-id`（推荐） | 同次飞书会话的多次 ERP 调用关联 | FrontLane |
| `x-user-confirm: <jwt>` | **写入类**操作必须；试跑（dryRun=true）不需要 | 用户 IM 卡片回调签发 |

---

## 4. HMAC 签名公式

```
ts    = "1716163800"             # Unix seconds
nonce = "550e8400-e29b-41d4-..."
body  = b'{"operation":"...","payload":{...},"dryRun":false}'

msg  = f"{ts}.{nonce}.".encode() + body
sig  = hmac.new(SECRET.encode(), msg, hashlib.sha256).hexdigest()
```

**校验规则**：
- `ts` 跟服务器时间相差 ≤ 5 分钟（防重放）
- `nonce` 在 10 分钟窗口内不可重复（防重放）
- `sig` 用 `compare_digest` 防时序攻击

`SECRET` 从 ERP 后端 `FRONTLANE_HMAC_SECRET` 配置项读，FrontLane 那边
要持有**同一个值**。生产环境必须在 .env 里替换默认值；DEBUG=False 启动
时如果还是 placeholder 会直接 raise（业务-2 修复保证）。

---

## 5. operation 路由表（截至 2026-05-21）

### 5.1 只读类（required_roles=[]，任意员工 + RLS 自动过滤）

| operation | 说明 |
|---|---|
| `query.orders` | 订单列表（按 brand/status 筛） |
| `query.customers` | 客户列表 |
| `query.inventory` | 库存（按 warehouse/product 筛） |
| `query.accounts` | 账户列表（按 brand/type 筛） |
| `query.policies` | 政策申请列表 |
| `query.purchase_orders` | 采购单列表 |
| `query.employees` | 员工档案 |
| `query.brands` | 品牌列表（建单时用） |
| `query.products` | 商品列表 |

### 5.2 订单 / 政策写入类（L2 主要走 dryRun + token 范式 B）

| operation | required_roles | 说明 |
|---|---|---|
| `orders.create_with_policy` | boss/salesman/sales_manager | 建单合并接口（Order + PR + items + submit-policy 一个事务）⭐ |
| `orders.approve_policy_with_request` | boss | 审批政策合并接口（同时推 Order.status + PR.status=approved；L1 推荐 Gateway）⭐ |
| `orders.reject_policy_with_request` | boss | 驳回政策合并接口（同时回退 Order + PR）|
| ~~`orders.create`~~ | — | ⚠️ legacy 禁用（只建 Order 不建 PR，ship 必失败）|
| ~~`orders.approve_policy`~~ | — | ⚠️ legacy 禁用（只动 Order，PR 不变）|
| `orders.ship` | boss/warehouse/salesman | 出库扫码（L1） |
| `orders.confirm_payment` | boss/finance | **L2** 财务确认收款（动 master 现金池） |
| `policies.confirm_arrival` | boss/finance | **L2** 政策项到账（applied → arrived，动 F 类账户） |
| `policies.confirm_fulfill` | boss/finance | **L2** 归档（settled，前置：关联订单 `payment_status=fully_paid`） |
| `policies.refund_advance` | boss/finance | **L2** 垫付返还（advance_refund） |

### 5.3 工资 / 报销 / 费用类（多个走 drafts 范式 C）

| operation | required_roles | 说明 |
|---|---|---|
| `payroll.confirm_subsidy_arrival` | boss/finance | **L2** 厂家补贴到账（动品牌现金）|
| `payroll.batch_pay` | finance | **L2 不可逆**（drafts；单批 ≤ 20 人）|
| `payroll.pay_salary` | finance | **L2 不可逆**（drafts；单条发工资）|
| `expense_claims.pay` | finance | **L2 不可逆**（drafts；员工垫付报销付款）|
| `finance.expenses.pay` | finance | **L2 不可逆**（drafts；公司日常费用付款，2026-05-21 加）|
| `policies.create_item_expense` | finance | **L2 不可逆** payer=company 走 drafts；payer=employee/customer 直调（仅登记）|
| `policies.update_item_expense` | finance | **L2 不可逆**（drafts，按 delta 冲销）|
| `policies.delete_item_expense` | finance | **L2 不可逆**（drafts，反向 credit + 减 actual_cost）|

### 5.4 采购类

| operation | required_roles | 说明 |
|---|---|---|
| `purchase.approve` | boss/finance | **L2** 审批采购单（写应付）|
| `purchase.cancel_approval` | boss | **L2** 撤销已批采购（反扣应付）|
| `purchase.receive` | boss/warehouse/purchase | L1 收货扫码（写 inventory_barcodes + barcode_registry + barcode_events） |

### 5.5 账户 / 调拨 / 融资 / 应收

| operation | required_roles | 说明 |
|---|---|---|
| `accounts.transfer` | boss/finance | **L2** 同品牌 / master 内调拨 |
| `accounts.approve_transfer` | boss | **L2** 跨品牌调拨审批（动账）|
| `accounts.manual_entry` | boss | **L2** 手工加流水（反向凭证）|
| `financing.confirm_arrival` | boss/finance | **L2** 融资放款到账 |
| `financing.pay` | finance | **L2 不可逆**（drafts；融资付款）|
| `financing.repay` | finance | **L2 不可逆**（drafts；还融资本金）|
| `receivables.write_off` | boss/finance | **L2** 应收坏账注销 |

### 5.6 稽查类

| operation | required_roles | 说明 |
|---|---|---|
| `inspections.execute_case` | boss | **L2** 案件执行（多账户动）|
| `inspections.return_to_warehouse` | boss | **L2** A1/A2 回库 |

### 5.7 草稿态（不可逆动账走这条）

| operation | required_roles | 说明 |
|---|---|---|
| `drafts.create` | boss/finance/hr/warehouse | 建动账类 draft（不动账，等用户卡片确认） |
| `drafts.commit` | boss/finance/hr/warehouse | commit draft → 真落账（必带 X-User-Confirm） |

合计 31 个 L2 operation 走 Gateway，其中 9 个不可逆动账必走 drafts 两阶段（`payroll.batch_pay` / `payroll.pay_salary` / `expense_claims.pay` / `finance.expenses.pay` / `policies.create_item_expense (payer=company)` / `policies.update_item_expense` / `policies.delete_item_expense` / `financing.pay` / `financing.repay`）。

---

## 6. 6 道闸门一图速览

调 `/api/agent/execute` 时按顺序经过：

```
1. require_frontlane_signature → HMAC 验真，错签 / 过期 / nonce 重放 → 403
2. operation 白名单 → 不在 _OPERATIONS 表 → 400 unknown operation
3. required_roles 校验 → 当前 employee.roles 没命中 → 403
4. rate-limit → 同 employee 30/min 超限 → 429
5. idempotencyKey 查重 → 同 key 24h 内有缓存 → 直接返上次结果
6. 批量 size 检查 → payload.items > spec.max_batch → 400
7. 写入类必带 X-User-Confirm → 校验 token 签名 + sub 匹配 + jti 未用 + action 匹配 → 不通过 403
8. dryRun → 事务内 SAVEPOINT 跑 + ROLLBACK + 独立 audit
   非 dryRun → 真执行 + audit_logs (actor_kind=ai_agent_assisted, channel=ai_agent)
```

---

## 7. AI Agent 调用范式（建议 SOP）

### 范式 A：只读查询

```python
# 直接调 dryRun=false（query.* 不支持 dry_run，跳过）
POST /api/agent/execute
  { operation: "query.orders", payload: {...} }
```

### 范式 B：写入类（含动账）

```python
# 1. 先 dryRun 看会发生什么
preview = POST /api/agent/execute
  { operation: "orders.confirm_payment", payload: {...}, dryRun: true }
# 给用户看 preview.result 的卡片

# 2. 用户点"确认" → IM 后端调 /api/confirm-tokens 拿 token
token = POST /api/confirm-tokens
  { action: "orders.confirm_payment", payload: {...} }

# 3. AI 携 token 真调
POST /api/agent/execute
  Headers: { "x-user-confirm": token.token }
  { operation: "orders.confirm_payment", payload: {...},
    dryRun: false, idempotencyKey: <uuid> }
```

### 范式 C：不可逆动账（推荐走 drafts）

```python
# 1. AI 创建 draft
draft = POST /api/agent/execute
  { operation: "drafts.create",
    payload: {
      action: "policies.create_item_expense",
      payload: { item_id, name, cost_amount, ...payer_type=company },
    } }
# draft.id, draft.status='pending'，账户没动

# 2. 给用户卡片预览 draft.payload 内容

# 3. 用户点确认 → token
token = POST /api/confirm-tokens
  { action: "drafts.commit", payload: { draft_id: draft.id } }

# 4. AI commit
POST /api/agent/execute
  Headers: { "x-user-confirm": token.token }
  { operation: "drafts.commit",
    payload: { draft_id: draft.id } }
```

---

## 8. 错误码速查

| HTTP | 错误 | 解决 |
|---|---|---|
| 400 | `unknown operation: xxx` | operation 不在 `/describe` 返回的清单里 |
| 400 | `批量 size N 超过 OP 上限 K` | 拆成多个调用 |
| 400 | `payment_status 不是 fully_paid` | 关联订单未付清，先收款 |
| 403 | `frontlane-timestamp / nonce / signature` 缺 | 三个 header 必须都带 |
| 403 | `signature mismatch` | HMAC SECRET 不一致 |
| 403 | `timestamp skew > 300s` | FrontLane 跟 ERP 时钟差距太大 |
| 403 | `nonce reused` | nonce 被复用 |
| 403 | `需要角色之一: ...` | 当前员工没相应角色 |
| 403 | `X-User-Confirm header` 缺 | 写入类必带 |
| 403 | `token 不属于当前用户` | token 是别人的 |
| 403 | `token 已被使用过` | 一次性 token，需重新让用户确认 |
| 429 | `Rate limit exceeded` | 1 分钟超 30 次写，等几秒重试 |

---

## 9. 跟 MCP 通道（`erp_request`）的关系

ERP 内部还有一条 MCP 工具叫 `erp_request`（FrontLane multi-user-agent
平台 container/agent-runner/src/mcp-tools/xinjiulong-erp.ts），它走的是：

```
飞书 IM → FrontLane → erp_request MCP tool
       → 调 /api/feishu/exchange-token 拿 JWT
       → 直接打任意 /api/* 业务路径
```

**两条通道并存**：

| 维度 | erp_request（旧） | /api/agent/execute（新） |
|---|---|---|
| 协议 | 自由 HTTP path | operation 命名 |
| HMAC | 否（X-Agent-Service-Key 静态 key） | 是（防重放 + 时间窗）|
| dryRun | 否 | 是 |
| idempotencyKey | 否 | 是 |
| rate-limit | 无 | 30/min/employee |
| audit | 默认 actor_kind=human_ui | actor_kind=ai_agent_assisted |
| 推荐何时用 | 探索性查询 / 还没注册到路由表的端点 | **写入 / 动账 / 关键状态推进** |

**铁律**：动账类、状态推进类、批量类**必须**走 `/api/agent/execute`，
绝不能走 erp_request 直打 `/api/*` —— 后者绕过 dryRun + idempotency +
确认 token。

---

## 10. 维护清单（新增 operation 时）

1. 在 `agent_gateway.py` 写 `_op_xxx` handler
2. 在 `_OPERATIONS` 字典登记 `OperationSpec`（name / description / required_roles / max_batch / supports_dry_run）
3. 跑 `scripts/e2e_agent_gateway.py` 确保不破回归
4. 更新本文 §5 路由表
5. 通知 FrontLane 团队新增了什么 operation

---

## 11. FrontLane 平台接入 checklist（一次性）

发给 multi-agent 平台开发的 agent 看：

- [ ] 配 `FRONTLANE_HMAC_SECRET`，跟 ERP `.env` 同值（值不在文档里出现 —— 老板线下私聊给。生成命令：`python -c "import secrets; print(secrets.token_hex(32))"`，64 位 hex）
- [ ] 跨域：ERP `CORS_ORIGINS` 已含 `https://mac.xinjiulong.cn` 和 multi-agent 平台域名；如换域名同步更新
- [ ] 实现 `/api/feishu/exchange-token` 缓存策略：按 `open_id` 分桶，TTL ≤ 15min，**绝不跨用户复用**
- [ ] 实现 `/api/confirm-tokens` 触发流程：用户点 IM 卡片 → IM 后端调此 → 把 token 注入下次 `execute` 的 `X-User-Confirm` header
- [ ] 错误处理：
  - 401 / 403 不自动重试，提示用户重新绑定 / 确认
  - 429 退避 60s 再试
  - 5xx / 网络超时按**同一 idempotencyKey** 重试，绝不新生成 key
- [ ] 时区：所有时间 API 返回 ISO-8601 UTC，展示按东八区格式化 `2026-05-21 10:30:15`
- [ ] 审计：每次 LLM 调 `/api/agent/execute` 必带 `X-Channel: ai-agent` + `X-Intent-Id: <conv_id>`，事后 ERP 那边可以反查"哪个 LLM 在哪次对话扣了哪笔账"
- [ ] HMAC 签名时机：**在 body 序列化为 bytes 之后立刻签**，不要在 body 改动后再次签名 —— sig 是对 body bytes 求的，body 改了 sig 失效
- [ ] nonce：UUID4 即可（10 min 不可复用），生产环境 Redis 缓存 nonce 池，过期回收
- [ ] 时钟同步：服务器跟 NTP 同步（容忍 ±5min），否则 timestamp skew 拒
- [ ] 不要让 LLM 直接读到 secret / token：HMAC SECRET 仅平台后端持有，X-User-Confirm token 由 IM 后端注入

## 12. 常见误用

| 误用 | 后果 | 正确做法 |
|---|---|---|
| LLM 自己生成 X-User-Confirm | 403 token 验签失败 | 必须用户点 IM 卡片，IM 后端调 `/api/confirm-tokens` 拿 |
| LLM 拿 admin token 替 salesman 查数据 | 越权 + 审计责任不清 | 必须用 salesman **本人** open_id 换的 JWT |
| dryRun=true 也带 X-User-Confirm | 浪费 token（一次性消耗）| dryRun 不需要 token，只有 dryRun=false 需要 |
| 同一 idempotencyKey 用于多个 draft | 第二个 draft 直接返第一个的结果 | 每个用户意图一个独立 idempotencyKey UUID |
| 5xx 后用新 idempotencyKey 重试 | 可能重复扣账 | 同一 key 重试，Gateway 24h 内同 key 返缓存 |
| 触发 429 后短时间内多次重试 | 继续 429 | 退避 60s 或转人工 |
| 提交 payload 后改了字段再 commit draft | 403 payload_hash mismatch | 改了就重新 drafts.create + 新 token |
| 跨 open_id 复用 JWT | 数据归属错乱 + 审计 user_id 不对 | 按 open_id 分桶，过期重新 exchange |
| 用户说"跳过审批"，Agent 直接调动账端点 | 后端 400 状态不对 / 403 缺 token / audit 留痕 | 拒绝 + 告诉用户当前实体在哪状态、下一节点是什么；推 dryRun 卡片让用户在飞书点确认 |
| 卡片预览显示 ¥27000，commit 时改 ¥1 | 403 payload_hash mismatch | preview 跟 commit 必须一字不差；改了重新 drafts.create + 拿新 token |

---

## 参考

- OWASP LLM06:2025 Excessive Agency
- OWASP Top 10 for Agentic Applications 2026 ASI02 / ASI09
- Salesforce Agentforce Atlas Reasoning Engine
- SAP Joule + Joule Studio
- Microsoft Copilot Studio Agent Flows
- 第三方 AI 安全审计报告（2026-05-19）
