# 订单模块 — 建单到送达完整闭环

覆盖：建单、政策审批、出库、送达、上传凭证。收款审批见 `receipt-approval.md`。

## 状态机

订单实际有**两条并行状态字段**：`status`（八态主流程）+ `payment_status`（四态付款进度）。这两条独立推进，互不阻塞，但 `completed` 必须同时满足 `status='delivered'` AND `payment_status='fully_paid'`。

### `status` 主流程（八态）

```
pending  ─(salesman 提交政策)→  policy_pending_internal
                                      ↓
                               (boss 批准)  → approved
                               (boss 驳回)  → policy_rejected
                                      ↓
                             (warehouse 出库)  → shipped
                                      ↓
                           (warehouse 上传送货照)  → delivered
                                      ↓                       ↑
                           (财务确认收款 + payment_status      |
                            达到 fully_paid)                   |
                                      ↓                       |
                                  completed                  |
                                (policy_rejected  ─ salesman resubmit)
```

### `payment_status` 付款进度（四态）

```
unpaid  ─(上传第 1 笔凭证)→  pending_confirmation  ─(财务确认 partial)→  partially_paid
            └────────────────────────────────────┘                            │
                                                  ↓                           │
                            (累计凭证补足 customer_paid_amount)               │
                                                  ↓                           │
                              财务一次性确认 → fully_paid ←───────────────────┘
```

| payment_status | 触发条件 | 后端写法 |
|---|---|---|
| `unpaid` | 默认 | 建单初始值 |
| `pending_confirmation` | 业务员上传任意凭证 | upload_payment_voucher 把 Receipt 建成 `pending_confirmation`，订单同步标 |
| `partially_paid` | 财务确认部分凭证、累计 < customer_paid_amount | orders.py:1404-1405 算 partial |
| `fully_paid` | 财务确认凭证后累计 ≥ customer_paid_amount | confirm-payment 时判 + 生成 Commission |

### 两条状态字段的关系

| status | 允许的 payment_status | 说明 |
|---|---|---|
| pending / policy_pending_* / approved / policy_rejected | unpaid（理论上其他也行，但少见） | 还没出货收钱意义不大 |
| shipped / delivered | unpaid / pending_confirmation / partially_paid / fully_paid | 任意 — 三种结算模式 + 后付款客户都正常 |
| completed | **必须** fully_paid | confirm-payment 时如果 status=delivered + payment_status 刚到 fully_paid，自动推进 status→completed |

**Agent 对应的 API**：

| 动作 | 端点 | 角色 |
|---|---|---|
| 建单预览（算金额/匹配政策） | `POST /api/orders/preview` | 任何登录员工 |
| 建单 | `POST /api/orders` | salesman/sales_manager/boss |
| 提交政策审批 | `POST /api/orders/{id}/submit-policy` | salesman/sales_manager |
| 批准政策 | `POST /api/orders/{id}/approve-policy` | boss |
| 驳回政策 | `POST /api/orders/{id}/reject-policy` | boss |
| 重新提交（被驳回后） | `POST /api/orders/{id}/resubmit` | salesman/boss |
| 出库 | `POST /api/orders/{id}/ship` | warehouse/boss |
| 上传送货照片 | `POST /api/orders/{id}/upload-delivery` | warehouse/boss |
| 上传收款凭证 | `POST /api/orders/{id}/upload-payment-voucher` | salesman/finance/boss |
| 查看订单 | `GET /api/orders/{id}` 或 `GET /api/orders` | 按 RLS 过滤 |
| 订单利润 | `GET /api/orders/{id}/profit` | finance/boss |
| 删除订单 | `DELETE /api/orders/{id}` | 仅 pending 状态可删；已过政策审批的禁止删 |

## 建单流程 — Agent 分步

### 第一步：收集必填参数（Agent 问用户）

**用户必须提供**：
- 客户（名字或编号，Agent 查 `GET /api/customers?keyword=...`）
- 品牌（一般从商品自动推断）
- 商品 + 数量（每条：product_id + quantity + quantity_unit='箱'）
- 结算模式（`customer_pay` / `employee_pay` / `company_pay`）— 必须明确问，**不要默认**

**可选**：
- 到手单价（`deal_unit_price`）覆盖政策模板默认值
- 备注

**关键校验**：
- 业务员（salesman 角色）不能给未绑到自己名下的客户建单——Agent 先用 `GET /api/customers` 确认客户可见（RLS 会挡住不该看的）
- 必须有已启用的政策模板匹配（品牌 × 箱数 × 到手价）——调 `GET /api/policy-templates/templates/match?brand_id=X&cases=N&unit_price=P` 先确认

### 第二步：预览（Agent 调 preview 不用用户确认）

```
POST /api/orders/preview
{
  "customer_id": "...",
  "salesman_id": "...",
  "settlement_mode": "customer_pay",
  "items": [{"product_id": "...", "quantity": 5, "quantity_unit": "箱"}],
  "policy_template_id": "..."    // 可空，后端自动匹配
}
```

返回金额（参见 `settlement-modes.md`）。

### 第三步：展示 + 用户确认

Agent 用大白话重复：

> 将建订单：
> - 客户：张三烟酒店
> - 品牌：青花郎
> - 商品：青花郎 53 度 500ml × 5 箱
> - 结算：客户按指导价付
> - 公司应收：¥27,000
> - 匹配政策：青花郎 5 箱基础政策（含赠品 1 箱）
>
> 确认建单？

### 第四步：建单（用户"确认"后）

```
POST /api/orders
{ 同 preview 的参数 }
```

返回 `order_no`（如 `SO-20260427091234-abc123`）告诉用户。

### 第五步：自动提交政策审批（可选）

建单后订单是 `pending`，**Agent 询问用户**是否立即提交政策审批：

> "订单建好了（SO-xxx）。要立刻提交政策审批吗？"

用户"是" → `POST /api/orders/{id}/submit-policy` → 进入 `policy_pending_internal`。

**Agent 不自动提交**——让用户有机会先检查再提。

## 接下来的流转 Agent 不介入

- **政策审批**：只能 boss 在前端点按钮或通过 `/api/orders/{id}/approve-policy` 端点。Agent 若是 boss 的 Agent，**必须展示完整订单摘要后要用户确认**。
- **出库**：warehouse 扫码流程，Agent 一般不做，提示用户"请在仓库扫码页面出库"
- **送达上传照片**：warehouse 完成，Agent 不做

## Agent 可以帮的"查询"类

| 用户问法 | Agent 调 |
|---|---|
| "我有哪些订单在等审批？" | `GET /api/orders?status=policy_pending_internal` |
| "这单到哪一步了？" | `GET /api/orders/{id}` 看 status + payment_status |
| "本月我建了多少单？" | `GET /api/orders?salesman_id=me&date_from=...&date_to=...` 聚合 |
| "张三烟酒店有哪些未付款订单？" | `GET /api/orders?customer_id=X&payment_status=unpaid` |

## 常见错误码

| HTTP | detail | Agent 怎么说 |
|---|---|---|
| 400 | "settlement_mode 必须为 ..." | 重新问用户模式 |
| 400 | "无法出库：该订单没有已审批的政策申请" | 告诉用户先完成政策审批 |
| 400 | "订单状态为 'X'，只有..." | 原样告诉用户 |
| 403 | （RLS 挡住） | "你看不到该订单，可能不在你绑定的品牌范围内" |

## 订单状态中英对照（给用户说话用）

| status | 中文 |
|---|---|
| pending | 待提交（新建） |
| policy_pending_internal | 内部审批中 |
| policy_pending_external | 厂家审批中 |
| approved | 已审批（待出库） |
| shipped | 已出库 |
| delivered | 已妥投 |
| completed | 已完成 |
| policy_rejected | 已驳回 |

| payment_status | 中文 |
|---|---|
| unpaid | 未付款 |
| partially_paid | 部分付款 |
| pending_confirmation | 凭证已交，待财务审批 |
| fully_paid | 已付清 |

---

## 门店零售（桥 B12）— store_sales 完全独立链路

**这是另一种"订单"**：4 家专卖店店员日常收银，跟上面的 SO-xxx 渠道/团购订单**不共享代码、不共享表、不走审批**。

### 仓 + 角色

- 仓库 = `warehouses.warehouse_type='store'`（warehouse_id 直接是门店）
- 角色 = `employees.position='cashier'` + 在 `employee_store_assignments` 里绑了这家门店；登录走 miniprogram 的 `mall_user`，靠 `mall_user.linked_employee_id` 找到 cashier 身份
- 权限隔离（m6cy 后）：`store_sales / store_sale_items / store_sale_returns` 三表都受 RLS 保护，policy 走 `store_id ∈ app_current_store_ids()` —— 只有绑了这家门店的员工 + admin 能看本店流水。品牌业务员（只绑品牌、没绑门店）调 `/api/store-sales` 返回空列表

### 端点（两个前缀同一份 router，注意挑对）

| 入口 | 前缀 | 谁用 |
|---|---|---|
| 管理端（ERP） | `POST /api/store-sales` | boss/finance/sales_manager 后台查/补录 |
| 小程序店员端 | `POST /api/mall/workspace/store-sales` | 店员手机扫码收银，跑得到这条 |

### 收银必传字段（_CreateBody）

```json
POST /api/mall/workspace/store-sales
{
  "customer_id": null,                       // 散客可空
  "customer_walk_in_name": "张大姐",         // 散客可填
  "customer_walk_in_phone": "138****",       // 散客可填
  "line_items": [
    {
      "barcode": "<厂家防伪码>",              // 必填，扫码逐瓶/箱
      "sale_price": "650.00",                // 必填，须落在 products.min/max_sale_price 区间
      "product_source": "liquor"             // 'liquor'（走 inventory_barcodes）| 'store_product'（走 store_products.stock_qty 杂货）
    }
  ],
  "payment_method": "cash",                  // 必填，正则 ^(cash|wechat|alipay|card)$，禁赊账
  "notes": "..."
}
```

### 后端做的事（store_sale_service.create_store_sale）

1. **扫码出库**：barcode 在 `inventory_barcodes` 中按门店仓查在不在 → 一瓶/一箱过户成 sold，写 `barcode_events`
2. **价格校验**：`sale_price` 必须 ≥ `min_sale_price` 且 ≤ `max_sale_price`（products 表），否则 400
3. **付款方式**：四值之一，**禁止赊账**（没有"unpaid 后补"路径）。现金类直接进账
4. **提成生成**：单瓶利润 = `sale_price - cost_price`，提成 = `利润 × retail_commission_rates.rate_on_profit`（每员工×每商品一个点）→ 生成一条 `Commission` 状态 `pending` → 月结时纳入工资单
5. **不走任何审批**：店员扫完即出货、即收银、即提成。boss 想看就在 ERP 后台 `/api/store-sales` 查流水

### Agent 在这条链路做什么？

- 一般 **Agent 不直接帮店员收银**（手机扫码是物理动作，Agent 没法触发扫码器）
- Agent 可帮店员/店长查询：
  - "今天我卖了多少？" → `GET /api/mall/workspace/store-sales/my/sales`
  - "本月汇总" → `GET /api/mall/workspace/store-sales/my/summary`
  - "刚才那瓶给王老板那条记录在哪？" → 按 barcode 过 store_sale_items
- Agent 可帮 boss/finance：
  - 跨店流水 → `GET /api/store-sales?store_id=X&date_from=...`
  - 退货 → `POST /api/store-sales/{id}/returns`（StoreSaleReturn 模型）

### 不混淆的关键点

| 概念 | 渠道/团购订单 | 门店零售 |
|---|---|---|
| 表 | `orders` + `order_items` | `store_sales` + `store_sale_items` |
| 状态机 | 八态 pending→...→completed | 无 status（一笔即完成）|
| 政策 | 走 PolicyRequest 整套链路 | 不走 |
| 付款 | 凭证 → 审批 → 入 master | 现金/微信/支付宝/卡，即时进账，禁赊 |
| 提成 | confirm-payment 时生成 | 创建时即生成（pending）|
| 出库 | 业务员扫码 + warehouse 发货 | 店员一人完成扫码+收银 |

Agent 帮用户时**先确认是哪种**，不要混在一起。
