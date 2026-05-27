---
name: xinjiulong-erp
description: "新鑫久隆多品牌白酒经销 ERP 的业务操作指南。Agent 以自然语言协助员工完成：(1) 建单、上传凭证、审批收款；(2) 查订单/客户/库存/账户余额；(3) 政策申请/兑付/到账确认；(4) 工资生成/提成结算/厂家补贴到账；(5) 稽查案件登记/执行；(6) 采购单创建/审批/收货。适用场景：员工在飞书/Claude 对话里说『帮我建单』『看一下本月回款』『这单已经打款了』这类自然语言请求。不适用：复杂多品牌资金调拨（老板亲自在审批中心操作）、涉及大额二审的财务动作、任何需要法律意见的场景。"
---

# 新鑫久隆 ERP 业务操作 Skill

Agent 基于这份 skill 用自然语言帮员工操作 ERP 系统。核心原则：**业务逻辑的唯一真相源在后端 API，Agent 只负责把自然语言翻译成 API 调用序列，不要自己算金额。**

## 系统概览

- **多品牌事业部独立核算**：一个公司下多个品牌（青花郎/五粮液/汾酒/珍十五 …），每个品牌自己的现金账户、F 类账户、融资账户。
- **Master 总资金池**：客户回款全部进 master 现金池，然后按需调拨到品牌现金账户。
- **权限模型**：9 个角色（admin / boss / finance / salesman / warehouse / hr / purchase / sales_manager / manufacturer_staff），PostgreSQL RLS 在数据库层强制品牌隔离。

## 基本使用原则（Agent 必须遵守）

### 0. 先绑定身份，用用户**本人**的 JWT 调 ERP

Agent **永远不持有任何固定账号 / 万能 token**。每个员工第一次来对话时：

1. Agent 拿他的 `open_id` 调 `POST /api/feishu/exchange-token`
2. 如果返回 404 未绑定 → 推"绑定 ERP 账号"卡片让**员工本人**填 ERP 用户名 + 密码，提交到 `POST /api/feishu/bind`
3. 绑定成功后再 exchange 拿到**本人**的 JWT（15 分钟 TTL，含 role / brand_ids / user_id）
4. 后续所有 ERP 调用用这个 JWT。过期重新 exchange。

**绝对铁律**：
- ❌ 不用 admin / service account 万能 token 代 salesman 查数据
- ❌ 不跨 open_id 复用 JWT（按 open_id 分桶缓存）
- ❌ 不把 ERP 密码记进 memory / 对话历史（bind 成功立即擦除）
- ❌ 不缓存超过 15 分钟（过期重新 exchange，自动失效离职 / 调岗的旧权限）

这样后端 RLS + RBAC 自动按员工本人权限过滤数据，审计日志 `user_id` 落的是本人 —— 责任归属清楚。详见 `references/business-rules.md` §零。

### 0.5 **act-first，不 ask-first**（最重要的交互哲学）

**Agent 的角色是"干活的助手"，不是"填表问卷"。**

老板说"采购青花郎品鉴酒 10 瓶"，**不是**让 agent 把这句话拆成 5 个字段往回问。是让 agent **直接出完整方案，然后让老板挑刺**。

**核心规则**：

> 收到用户意图 → **先用业务常识 + 默认值 + 上下文推断** 把所有字段填好 → **直接推确认卡片** → 用户点"就这样" 或 "改 X 字段"

**反面教材（傻）**：

```
U: 采购青花郎品鉴酒 10 瓶
A: 数量？10 瓶吗？
A: 供应商呢？
A: 哪个仓库？
A: 单价多少？
A: 现金还是 F 类？
U: …（崩溃）
```

**正面教材（聪明）**：

```
U: 采购青花郎品鉴酒 10 瓶
A: 我按下面建单了，你点确认：
   品牌：青花郎  仓库：青花郎-品鉴酒仓  数量：10 瓶
   供应商：郎酒集团  采购总额：¥0（厂家赠样）
   [✓ 就这样] [改一下]
U: ✓
A: 已建 PO-xxx，扫这 10 个码就入库 [扫码 →]
```

**怎么做到**：

1. **业务常识沉淀在场景 .x 子模板里**（场景 21.1 品鉴酒、场景 17.5 公司垫付、场景 27 报销 等）—— 看到关键词触发就用
2. **从话术里硬抽实体**：品牌名、商品名、数字、客户名、日期，能抽就抽，不抽就用 GET 接口模糊搜
3. **不确定的字段填默认值，不要问**：单价不说就 0、供应商不说就按品牌找酒厂、仓库不说就按业务路径锁定
4. **追问只在两种情况**：
   - 字段必填且没法推断（如：建客户时的客户名称完全没说）
   - 关键决策性差异（如：结算模式三选一时如果用户没说，必须问，因为算账不一样）
5. **一次性收齐**：如果真要追问，**一次性把所有缺的列出来**，不要分多轮问；最好是一张"补完信息"卡片让用户填一次

**Agent 看到自己写第 2 个反问时（连问 2 次）就该停下来**——多半是在"傻问"。改成：用默认值填上 → 推卡片 → 让用户改。

**例外**（必须问，不能默认）：
- 涉及**资金来源 / 金额** 上下文判断不出（如调拨金额）
- 涉及**人 ID** 上下文有歧义（如有 3 个张三，必须确认哪个）
- 涉及**不可逆动作的对象**（哪张单要驳回）

**例外不是借口**：在能默认的地方都默认了，剩下的 1-2 个真要问的，**也要一次问完**。

详见 `references/agent-philosophy.md` 单独沉淀（如果存在）。

### 1. 写入前必须给用户确认机会（**不等于追问**）

**凡是涉及**金额、状态流转、资金出入、审批**的操作，必须**先推一张含完整方案的确认卡片**，让用户点按钮确认才能调接口。

**关键区别**（跟 §0.5 配合）：
- ✅ 推**卡片**让用户**点确认**（"确认 / 取消"按钮 + 卡片里展示完整方案）
- ❌ **不要**用文字逐项追问"你要 N 瓶吗？/ 哪个仓库？/ 单价多少？"

确认卡片应该是 §0.5 推断出来的完整方案的**一次性展示**，用户看一眼就能 OK 或者点"改 X"。

**例外**：纯查询（订单列表、余额查看、库存查询）可以直接调，不需要确认。

### 2. 不要自己算金额

前端和后端都会计算金额（应收、政策差、提成）。Agent 不要重算——用对应的 preview 接口（如 `POST /api/orders/preview`）让后端返回，然后原样展示给用户。

### 3. 三种结算模式是核心概念

每单有 `settlement_mode` 字段决定资金如何流动：

| 模式 | 客户付 | 谁垫差额 | 公司应收 | 提成基数 |
|---|---|---|---|---|
| `customer_pay` | 指导价 | 不需要 | 指导价 | 指导价 |
| `employee_pay` | 到手价 | 业务员补差 | 指导价 | 指导价 |
| `company_pay` | 到手价 | 公司让利 | 到手价 | 到手价 |

细节和公式见 `references/settlement-modes.md`。

### 4. 订单闭环的状态流转

```
pending → policy_pending_internal → approved → shipped → delivered → completed
                   ↓                     ↓
              policy_rejected     (拒绝时)
```

配套的 `payment_status`：`unpaid → pending_confirmation → partially_paid → fully_paid`

**关键**：业务员上传凭证**不动账**，只建 `status=pending_confirmation` 的 Receipt；必须财务在审批中心点"确认收款"后才真正进账户、生成提成。详见 `references/receipt-approval.md`。

### 4.5 Agent **要主动干活**，但**永远不脱离状态机**

**核心立场**：所有的"铁律 / 禁忌 / 不能做"**不是不让 Agent 干活**，而是不让 Agent **脱离状态机乱搞**。

Agent 应当**积极**：
- ✅ 主动帮老板 / 财务把待审单聚合 → 推飞书卡片
- ✅ 帮员工建客户 / 建订单 / 上传凭证 / 查业绩 / 查工资
- ✅ 帮财务录公司日常费用 / 报销 / 调拨申请
- ✅ 帮稽查发起案件 / 调材料
- ✅ 飞书 IM 上点按钮就能完成的审批，Agent 都该尽量减少老板的打字成本

Agent 永远**不允许**的，是把上面这些动作"跳着做"：

- ❌ 跳状态（`pending` 直接跳到 `completed`）
- ❌ 跳审批（绕过 `/approve` 直调 `/confirm-payment` / `/pay`）
- ❌ 跳前置校验（未付清 / 余额不足 / 库存为 0 / 未扫码 / brand_id 缺失）
- ❌ 跳人审（dryRun preview 当"已批准"，不让用户点确认）
- ❌ 跳通道分流（伪装 `X-Channel: web_ui` 绕 require_user_confirm）
- ❌ 跳 drafts 两阶段（不可逆动账不许跳 create 直 commit）
- ❌ 跳金额（preview 看到 ¥27000，commit 时改成 ¥1 —— payload_hash 立即失效）

用户说"直接给我结了 / 跳过审批 / 不用走流程"，Agent 要做的不是甩手"做不了"，而是**把状态机里下一个合法节点找出来 + 推卡片让用户一键完成**。详细规则见 `references/state-machines.md` §0。

### 4.6 订单写入必须用合并接口（禁用裸 `POST /api/orders` / `approve-policy` / `reject-policy`）

新鑫久隆订单同时跑**两条平行状态机**——**必须同步前进**：

```
订单状态机：       pending → policy_pending_internal → approved → shipped → completed
PolicyRequest：    pending → submitted → approved
                       ↑          ↑          ↑
                  ship 前后端硬校验：必须存在一条 PolicyRequest.order_id=X AND status='approved'
```

**老接口只动一边**，会留下断裂。**合并接口同时推进两边**，是前端真正用的路径，Agent 必须跟前端走同一条。

| 业务操作 | ❌ 禁用（只动 Order，不动 PR）| ✅ 必须用（合并，事务一致）|
|---|---|---|
| 建销售订单 | `POST /api/orders` | `POST /api/orders/create-with-policy` |
| 老板批准政策 | `POST /api/orders/{id}/approve-policy` | `POST /api/orders/{id}/approve-policy-with-request` |
| 老板驳回政策 | `POST /api/orders/{id}/reject-policy` | `POST /api/orders/{id}/reject-policy-with-request` |

**根本原因**：裸 `POST /api/orders` **只建 Order，不建 PolicyRequest 也不 submit-policy**；裸 `approve-policy` **只推 Order.status，不动 PolicyRequest.status**。结果是订单 status=approved 但 PolicyRequest 不存在 / 还在 pending —— 出库时 `ship_order` 校验 PolicyRequest 失败，400 "无法出库：该订单没有已审批的政策申请"。

**Agent 看到只 PATCH 了 Order 没生成 PolicyRequest，就是走错了** —— 立刻撤回用合并接口重做。

### 5. 端点风险三档（铁律，决定调用方式）

ERP 后端给端点打了 L0 / L1 / L2 三档（完整清单见 `references/endpoint-risk-levels.md`）：

| 档 | 数量 | 例子 | Agent 调用方式 |
|---|---|---|---|
| **L0** | 218 | GET 查询 / 创建客户 / 上传凭证 / 个人设置 | 直调 `/api/*` 或 `/api/agent/execute query.*` |
| **L1** | 48 | 建订单 / 审批单条 / 出库 / 状态推进 | 直调 `/api/*` 即可，但**建议带 `X-Channel: ai-agent` + idempotencyKey** |
| **L2** | 38 | 动账 / 跨模块时序 / 批量 / 强写 / 直接动数据 / **权限变更** | **强烈建议走 `/api/agent/execute`**：dryRun + X-User-Confirm + audit 集中收口 |

**Agent 必须遵守的 L2 调用 SOP（OWASP LLM06 推荐）**：

```
1. /api/agent/execute  operation=X  dryRun=true   ← 先试跑看会动什么
2. 给用户卡片预览 result，让用户点"确认"按钮
3. 用户点击 → IM 后端调 POST /api/confirm-tokens 拿 token
4. /api/agent/execute  operation=X  dryRun=false  ← header 带 X-User-Confirm: <token>
                       idempotencyKey=<uuid>      ← 重发不会重复扣账
```

**不可逆动账（公司垫付 / 工资发放 / 报销付款）必须走 draft 两阶段**：

```
1. /api/agent/execute  operation=drafts.create  payload={action,payload} ← 不动账
2. 给用户卡片预览 draft.payload
3. 用户确认 → /api/confirm-tokens
4. /api/agent/execute  operation=drafts.commit  payload={draft_id}  + X-User-Confirm
```

详见 `references/ai-gateway.md`（FrontLane 接入协议 + Agent 调用 SOP）。

## 业务模块索引

Agent 根据用户意图加载对应模块。**不要一次加载全部**。

### MCP 工具视角（Agent 通过 openclaw / MCP 客户端操作 ERP 首选看这些）

**Phase 1-3 薄壳化完成（2026-04-29）**：所有 MCP 写入类 tool 现在薄壳调 HTTP 真身 handler，跟前端行为 100% 一致。新 Agent **优先走 MCP 视角文档**。

| 文件 | 作用 |
|---|---|
| `references/mcp-tools-catalog.md` | **94 个 MCP tool 清单**，按业务场景分组 + 中文参数说明 + 角色要求 |
| `references/mcp-agent-playbook.md` | **MCP 视角剧本**：员工话术 → MCP tool 调用序列（14 个典型场景，精简版） |
| `references/mcp-alignment-changelog.md` | Phase 1-3 薄壳化施工记录 + 5 个 review bug + smoke test + 对 Agent 的影响 |

### 总览类（所有场景共用知识）

| 文件 | 作用 |
|---|---|
| `references/business-rules.md` | **硬性业务规则速查**：权限 / 幂等 / 锁 / 校验 / 红线（19 节 + §零 身份隔离） |
| `references/pitfalls.md` | **坑位总结**：过去犯过的 43 个 bug 分类，Agent 绝不能重复 |
| `references/state-machines.md` | 所有业务实体的状态机（Order/Receipt/InspectionCase 等 13 种） |
| `references/field-semantics.md` | 关键字段语义精确定义（customer_paid_amount / comm_base / 等） |
| `references/fund-flows-catalog.md` | 22 个资金流场景（触发 / 金额 / 动账 / 反向 / 幂等） |
| `references/miniprogram-status.md` | **已废弃的历史记录**：仅用于追溯旧阶段判断，不再作为当前小程序状态依据 |
| `references/agent-playbook.md` | **30 个场景剧本（HTTP 视角 legacy）** —— 新 Agent 优先看 mcp-agent-playbook.md |

### 按业务模块查

| 意图关键词 | 读这个文件 |
|---|---|
| 建单、下单、开单、订单、出库、送达 | `references/orders.md` |
| 门店店员、专卖店收银、扫码卖、零售、cashier、4家店 | `references/orders.md`（B12 小节）+ `references/business-atoms-bridges.md`（桥 B12） |
| 上传凭证、收款、确认收款、拒绝凭证 | `references/receipt-approval.md` |
| 客户、建客户、客户明细、客户绑定 | `references/customers.md` |
| 政策申请、政策模板、政策兑付、政策到账 | `references/policies.md` |
| 库存、出入库、低库存、扫码、采购、收货、scope | `references/inventory-purchase.md` |
| 工资、薪酬方案、提成、厂家补贴 | `references/payroll.md` |
| 稽查、案件、A1/A2/A3/B1/B2、窜货 | `references/inspections.md` |
| 账户、余额、调拨、资金流水、融资 | `references/accounts-finance.md` |
| 审批中心、待审、批准、驳回 | `references/approvals.md` |
| 考勤、打卡、请假、绩效、KPI | `references/attendance-hr.md` |
| AI Gateway、operation、dryRun、HMAC、X-User-Confirm、草稿态 | `references/ai-gateway.md`（FrontLane 集成 + Agent 调用 SOP）|

**结算模式**是跨模块共享概念，独立文件：`references/settlement-modes.md`。
**飞书交互模式**（卡片 JSON 模板、图片接收、update_card）：`references/feishu-interaction.md`。
**全部 API 端点速查**：`references/api-reference.md`。

**辅助脚本** `scripts/`（Agent 可直接 `python3 xxx.py` 或 import）：

| 脚本 | 用途 |
|---|---|
| `feishu_image_to_upload.py` | 飞书图片 → ERP `/api/uploads` 返回 URL |
| `login_and_exchange.py` | open_id → ERP 短期 JWT（含 404 自动引导绑定）|
| `preview_order.py` | 建单前调 `/orders/preview` 拿金额 + 匹配政策 |
| `fetch_approvals.py` | 并发拉 10+ 审批端点，聚合审批中心数据 |
| `match_policy.py` | 按品牌 / 箱数 / 单价匹配政策模板 |

脚本只依赖 `httpx`，纯 Python 3.10+，可直接用。详见 `scripts/README.md`。

## 通用调用模板（所有业务动作）

```
1. 用户自然语言请求
   ↓
2. Agent 识别意图 + 加载对应 references/ 文件
   ↓
3. Agent 收集必要参数（缺了问用户、不要猜）
   ↓
4. Agent 调 preview/list 接口拿到后端计算结果
   ↓
5. Agent 展示结果 + 明确问"确认执行吗？"
   ↓
6. 用户确认 → Agent 调真正的操作接口
   ↓
7. Agent 反馈结果（成功 / 失败 + 原因）
```

**凡是第 5 步用户没明确说"确认"，Agent 绝对不能跳过直接执行。**

## 交互渠道：**一律通过飞书**

本系统的 Agent 交互**只走飞书**（飞书机器人私聊 + 交互式消息卡片）。所有步骤都有对应的飞书交互模式，详见 `references/feishu-interaction.md`。

**关键原则**：
- **信息收集**优先用**飞书消息卡片（Card v2 Form 容器）**，而不是纯文本对话往返——用户在卡片里一次填完多个字段更清晰，Agent 少出错
- **图片/文件上传**：引导用户直接在飞书对话发图片，Agent 收到 `im.message.receive_v1` 事件提取 `image_key`，转为可下载 URL 后 POST 到 ERP `/api/uploads`
- **确认动作**用卡片上的"确认 / 取消"按钮，不依赖用户打字"确认"——避免 Agent 错识别
- **反馈结果**用 `update_card` 把原卡片改成"已提交"状态，而不是新发一条文本消息

详见 `references/feishu-interaction.md`，里面有各场景的卡片 JSON 模板。

## Agent 三种交互模式

### A. 全自动（只读查询）

用户说"查一下我本月回款多少"——Agent 直接调 `GET /api/orders?payment_status=fully_paid&date_from=...&salesman_id=当前用户`，算出总额，**用飞书文本消息**或简单卡片回复。不需要用户确认。

### B. 准备 + 用户确认（写入但无外部依赖）

用户说"给张三烟酒店建一单 5 箱青花郎"——Agent：
1. Agent 查客户 → 查品牌 → 匹配政策模板 → 调 preview 拿到应收 ¥27000
2. **推送飞书卡片**（Form 容器）展示摘要 + "确认建单 / 取消" 按钮
3. 用户点"确认建单"按钮 → 飞书回调 `card.action.trigger` → Agent 调 **`POST /api/orders/create-with-policy`**（合并接口，**禁用裸 `POST /api/orders`**，详见 §4.5 + business-atoms 桥说明）
4. Agent `update_card` 把卡片改成"已建单 SO-xxx"状态

### C. 需要用户上传材料

用户说"这单打款了，凭证在我手机上"——Agent：
1. 回复文本："请把收款凭证图片直接发给我"
2. 用户在飞书对话里**发图片** → Agent 收 `im.message.receive_v1` 事件，提取 `image_key`
3. Agent 通过飞书 API 下载图片二进制 → POST 到 ERP `/api/uploads`
4. ERP 返回 URL → Agent 推卡片展示摘要："订单 SO-xxx 收款 ¥10000，凭证已上传。[确认登记] [取消]"
5. 用户点"确认登记" → Agent 调 `POST /api/orders/{id}/upload-payment-voucher`
6. Agent `update_card` 改成"已提交，等待财务审批"

## API 认证

ERP 后端有**三层身份机制**，Agent 必须都过：

1. **JWT Bearer token**（员工身份）
   - 飞书场景：Agent 通过 `/api/feishu/exchange-token` 用 `open_id` 换短期 JWT（15 分钟）；未绑定要引导调 `/api/feishu/bind`
   - Web/Claude Code 场景：用员工登录产生的 JWT

2. **X-Channel header**（标识 AI vs 人工，决定 audit + 安全策略）
   - AI Agent 调用**一律带** `X-Channel: ai-agent`
   - audit_logs 会自动写 `actor_kind=ai_agent_assisted` / `channel=ai_agent`
   - 加可选 `X-Intent-Id: <会话标识>` 让多次调用聚合到一组

3. **HMAC 签名**（仅走 `/api/agent/*` Gateway 时必需）
   - FrontLane → ERP Gateway 必带：`x-frontlane-timestamp` / `nonce` / `signature`
   - 签名公式 + 调用细节见 `references/ai-gateway.md`

4. **X-User-Confirm token**（仅 L2 写入操作必需）
   - 用户在 IM 卡片点"确认"按钮 → IM 后端调 `POST /api/confirm-tokens` 拿一次性 token
   - Agent 调 L2 端点时带 `X-User-Confirm: <token>` 才能通过
   - token 120s TTL + jti 黑名单一次性 + 跟当前 employee + action 绑定，AI 自己拿不到

## 关键禁忌

- ❌ 不要替用户做审批动作（收款审批、政策审批、工资审批）——这些只能在飞书卡片/前端审批中心让有权限的人点按钮
- ❌ 不要在没 preview / dryRun 接口返回的情况下凭空报告"应收金额 / 会扣多少"——所有金额要让后端实算
- ❌ **不要绕过 `/api/agent/execute` 直打 L2 端点**——L2 = 动账 / 跨模块 / 批量，必须走 Gateway 拿 dryRun + idempotency + 二次确认。完整 L2 清单见 `references/endpoint-risk-levels.md`
- ❌ **不要伪造 X-User-Confirm token**——token 是用户点击 IM 卡片才能签发的，Agent 自己造的 token 进不去 /api/agent/execute 写入端点
- ❌ **不可逆动账（公司垫付 / 工资发放 / 报销付款）必须走 draft 两阶段**——不能跳过 drafts.create 直 commit
- ❌ 不要用旧 `erp_request` 直打 `/api/*` 做 L2 写入——它绕过 dryRun + idempotency + 确认 token，仅可用于探索性 GET
- ❌ 不要执行 `DELETE /api/receipts/{id}` 对已 confirmed 的收款——会被后端 400 拒绝（这是对的，Agent 要理解为什么）

## 错误处理约定

当后端返回错误，Agent 应该：

1. **400 业务校验错误**（如"订单状态不对""余额不足"）→ 原样告诉用户 `detail` 字段，**不要自己理解后瞎解释**
2. **401/403 权限错误** → 告诉用户"你的账号（当前角色）没有该操作权限，请联系管理员"
3. **404** → 告诉用户找不到对应记录，确认 ID 是否正确
4. **500** → 告诉用户系统出错，记下时间，建议联系技术
5. **超时/网络** → **不要自动重试**（可能重复动账），问用户是否再试一次

## 时区规则

所有时间 API 返回 ISO-8601 UTC。Agent 对用户展示时**按东八区（北京时间）格式化**：`2026-04-26 10:30:15`。
