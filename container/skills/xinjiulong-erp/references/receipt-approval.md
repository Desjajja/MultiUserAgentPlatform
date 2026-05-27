# 收款凭证与审批

**核心规则（P2c-1 改造）：业务员上传凭证不再直接进账，必须财务在审批中心确认后才真正动账。**

## 数据流

```
业务员上传凭证 → Receipt 建为 status=pending_confirmation → 通知财务
                                                              ↓
财务审批中心点"批准" → Receipt 状态改 confirmed
                    → master 现金池 += amount
                    → 写 fund_flow
                    → 重算订单 payment_status
                    → 累计全款时订单 status → completed
                    → 生成 Commission（pending 状态，等工资结算）
                    → 刷 KPI / 推销售目标里程碑通知
                    → 分摊应收账款

财务审批中心点"拒绝" → 所有 pending Receipt 状态改 rejected + 记原因
                     → 通知业务员
                     → 订单 payment_status 回退
                     → 不动账
```

## 三种建收款的路径

| 路径 | 端点 | 谁调 | 状态 | 立即动账？ |
|---|---|---|---|---|
| A：业务员上传凭证 | `POST /api/orders/{id}/upload-payment-voucher` | salesman/finance/boss | `pending_confirmation` | ❌ 不动 |
| B：财务直接建 | `POST /api/receipts` | finance/boss/admin | `confirmed` | ✅ 立即动 |
| C：审批中心批准（A 的下一步）| `POST /api/orders/{id}/confirm-payment` | boss/finance | 批量把 A 建的 pending → confirmed | ✅ 动账 |

**Agent 绝大多数场景用路径 A**（让业务员走正规流程）。只有 finance/boss 身份的用户明确说"我要直接入账跳过审批"时才用路径 B。

## 订单的 payment_status 含义

| 值 | 何时出现 |
|---|---|
| `unpaid` | 默认（初建订单）|
| `pending_confirmation` | 业务员至少上传了一笔 pending Receipt，还没被财务处理（批/拒都没）|
| `partially_paid` | 审批后已 confirmed 的 Receipt 累计 > 0 但 < 应收 |
| `fully_paid` | 已 confirmed 累计 ≥ 应收 |

**注意**：`pending_confirmation` 是"有待审凭证"状态——**即使之前有 confirmed 的凭证累计不到全款，只要新上传一笔就回到 pending_confirmation**。这是设计上的"one-fails-all-fails"（用户决策：D3 Q1=B）。

## Agent 分步：业务员上传凭证

### 前置校验

- 订单 `status` 必须是 `delivered`（已送达）
- 金额 > 0
- 业务员有上传权限（RLS 自动按 brand 过滤）

### 交互流程

```
用户："张三这单客户打款 ¥10000 了，凭证我发给你"
  ↓
Agent 要求上传图片
  ↓
用户发图 → Agent 调 POST /api/uploads 上传（multipart/form-data，Blob 必须带 filename）
  ↓
Agent 拿到 url: /api/uploads/files/YYYY-MM/<uuid>.jpg
  ↓
Agent 展示确认：
  "将登记订单 SO-20260427091234 收款 ¥10,000，来源=客户付款，凭证已上传。确认？"
  ↓
用户"确认"
  ↓
Agent 调 POST /api/orders/{id}/upload-payment-voucher
  Body:
    {
      "amount": 10000,
      "voucher_urls": ["<uploads 返回的 url>"],
      "payment_method": "bank",      // 可省略，默认 bank
      "source_type": "customer"      // customer / employee_advance / company_advance
    }
  ↓
Agent 反馈：
  "已提交 ¥10,000 凭证，等待财务审批。你可以继续其他操作，财务批准后会推通知。"
```

### `source_type` 值

- `customer`：客户付款（默认；Receipt model `default="customer"`）
- `employee_advance`：业务员垫付补款（`employee_pay` 模式才用；orders.py:1216 注释里唯一明确的另一个值）
- `company_advance`：文档保留口径，**代码无强分流**——上传时即使传过去，后端不会按它走特殊路径，落表后等同 `customer`。`company_pay` 模式实际只用 `customer`（客户付的就是到手价）

**不要传 `policy_f`** —— 代码不识别。

### 分多笔上传

`employee_pay` 模式下一笔客户凭证 + 一笔业务员补差凭证——分两次调接口，每次用不同的 `source_type`。订单应收凑齐后 `payment_status` 仍是 `pending_confirmation`，等财务一次性批。

## Agent 分步：财务批准收款

**只对 boss/finance 角色生效。Agent 如果不是这两个身份，不要执行这个动作。**

### 看待审列表

```
GET /api/orders/pending-receipt-confirmation?brand_id=可选
```

返回每个待审订单：
```
{
  "order_id": "...",
  "order_no": "SO-...",
  "customer_paid_amount": 10000,
  "pending_receipt_count": 2,
  "pending_receipt_amount": 10000,
  "settlement_mode": "customer_pay",
  ...
}
```

Agent 展示："有 N 个订单等你确认：SO-xxx 金额 ¥... （Y 笔凭证）..."

### 批准

用户"批准这单" →

```
POST /api/orders/{id}/confirm-payment
```

无请求体。后端自动：
- 所有 pending Receipt → confirmed
- master 账户 += SUM(Receipt.amount)
- 写 fund_flows
- 重算 payment_status，全款则订单 → completed
- 生成 Commission（首次 fully_paid）
- 刷 KPI + 推里程碑

**注意按订单批**（用户决策 D3 Q1=B）：一次把该订单所有 pending Receipt 一起处理，不能单独挑某一条批。

### 拒绝

用户"拒绝这单，凭证模糊" →

```
POST /api/orders/{id}/reject-payment-receipts
Body: { "reason": "凭证模糊" }
```

后端把该订单所有 pending Receipt → rejected + 记原因 + 通知业务员。订单 `payment_status` 回退（如果全拒，回 `unpaid`）。

## 常见错误

| detail | 意思 | Agent 怎么办 |
|---|---|---|
| "订单状态为 'pending'，只有已送达的订单才能上传收款凭证" | 订单还没 delivered | 告诉用户订单没到送达阶段 |
| "金额必须大于 0" | amount ≤ 0 | 重新问金额 |
| "未配置公司总资金池" | master 账户缺失 | 告诉用户"系统配置问题，请联系管理员" |
| "此订单没有待审的凭证" | reject 时订单里没 pending | 可能别人已经处理过了，Agent 刷新后重试 |
| "收款 RC-xxx 已入账，不能删除" | delete confirmed Receipt | Agent 告诉用户走反向凭证流程，不要硬删 |

## 不幂等的操作 Agent 要小心

**`confirm_payment` 本身是幂等的**（再调一次看不到 pending Receipt 就没事）。

**但 `upload_payment_voucher` 不幂等**——每调一次就多建一条 Receipt。Agent 接到后端超时/网络错误时**不要自动重试**，问用户是否再发一次。

## 反向凭证（已入账后要撤销）

已 confirmed 的 Receipt 不允许删除（后端 400）。要撤销必须建**反向凭证**：`POST /api/receipts` 建一笔 `amount = 负数` 的收款，备注"撤销 RC-xxx"。这个操作只允许 finance/boss，Agent 要明确向用户强调"这是调账动作，不可逆"再执行。
