# 审批中心（所有待审事项聚合）

**审批中心不是一个独立表**，是前端页面聚合多个不同实体的 pending 状态。Agent 通过各个独立端点拉取并按优先级推给有权限的人。

## 待审事项分类

### 1. 订单收款待审（P2c-1 核心）

```
GET /api/orders/pending-receipt-confirmation
```

返回：所有 `payment_status='pending_confirmation'` 且至少有一条 Receipt.status='pending' 的订单。

**批准**（批量）：
```
POST /api/orders/{id}/confirm-payment
```

批准后**该订单全部 pending Receipt 一次性确认**（Q1=B all-or-nothing）。Agent 不支持一条一条确认。

**拒绝**（批量）：
```
POST /api/orders/{id}/reject-payment-receipts
{ "reason": "凭证金额与订单对不上" }
```

该订单全部 pending Receipt 标记为 rejected；业务员收到驳回通知要重新上传。

**权限**：boss。

### 2. 政策审批

```
GET /api/orders?status=policy_pending_internal
GET /api/orders?status=policy_pending_external
```

Internal = 内部老板审；External = 厂家审。

```
POST /api/orders/{id}/approve-policy
POST /api/orders/{id}/reject-policy
{ "reason": "..." }
POST /api/orders/{id}/confirm-external         # 厂家外审确认
```

**权限**：boss（internal），厂家账号（external）。

### 3. 采购审批

```
GET /api/purchase-orders?status=pending
POST /api/purchase-orders/{id}/approve
POST /api/purchase-orders/{id}/reject
{ "reason": "..." }
```

**权限**：finance / boss。

### 4. 调拨审批

```
GET /api/accounts/pending-transfers
POST /api/accounts/transfers/{id}/approve
POST /api/accounts/transfers/{id}/reject
```

**权限**：boss。

### 5. 工资审批

```
GET /api/payroll/salary-records?status=pending_approval
POST /api/payroll/salary-records/{id}/approve
POST /api/payroll/salary-records/batch-confirm
```

**权限**：boss / finance。

### 6. 请假审批

```
GET /api/attendance/leave-requests?status=pending
POST /api/attendance/leave-requests/{id}/approve
{ "action": "approve" | "reject", "reason": "..." }
```

**权限**：hr / boss（按流程）。

### 7. 付款申请审批

```
GET /api/payment-requests?status=pending
PUT /api/payment-requests/{id}            # status=approved / cancelled
POST /api/payment-requests/{id}/confirm-payment
```

说明：
- `pending`：待审批
- `approved`：已审批，待财务确认线下付款
- `paid`：财务已确认付款并完成记账
- `cancelled`：申请取消，不再进入记账链

**权限**：finance / boss。

### 8. 报销审批（**前端入口 2026-05-21 拆分**）

**前端通道**：
- 申请：ERP 顶部「报销申请」/ 小程序 `/pages/salesman-expense` — 任意员工可提
- **审批**：ERP「审批中心 → 综合审批 → 报销待审」Tab — boss/finance/hr 唯一入口
- 付款：ERP「报销申请」页操作列（仅 admin/boss/finance 看得见）→ L2 走 drafts

```
GET  /api/expense-claims?status=pending                列待审（聚合接口已合并到审批中心 PaymentRequest tab）
POST /api/expense-claims/{id}/approve                  🟡 L1 通过（人工操作，Agent 不替老板点）
POST /api/expense-claims/{id}/reject                   🟡 L1 驳回
POST /api/expense-claims/{id}/pay                      🔴 L2 不可逆 付款（走 drafts.commit → expense_claims.pay）
```

**权限**：按报销金额和类型分级（小额 hr/finance，大额 boss）。Agent 提交时不挑权限——后端 require_role 接受所有员工角色。

### 9. 融资还款审批

```
GET /api/financing-orders/pending-repayments
POST /api/financing-orders/repayments/{id}/approve
POST /api/financing-orders/repayments/{id}/reject
```

**权限**：finance / boss。

### 10. 费用审批

```
GET /api/expenses?status=pending
POST /api/expenses/{id}/approve
POST /api/expenses/{id}/reject
POST /api/expenses/{id}/pay
```

### 11. 商城凭证待确认（桥 B5）

```
GET /api/mall/admin/payments/pending
```

返回：小程序业务员上传的 `MallPayment.status='pending_confirmation'` 凭证。

**批准**：调 admin 确认订单收款端点（触发利润/提成）
```
POST /api/mall/admin/orders/{id}/confirm-payment
```

**驳回**：
```
POST /api/mall/admin/payments/{id}/reject
{ "reason": "..." }
```

**权限**：admin / boss / finance。

**⚠ 超时告警**（G15）：系统每小时 :15 扫 PENDING_CONFIRMATION 超 24h/48h，推 admin/boss/finance 通知。Agent 被问"凭证挂多久"时查 `created_at` 计算小时数。

### 12. 商城退货待审

```
GET /api/mall/admin/returns?status=pending
```

**批准**：
```
POST /api/mall/admin/returns/{id}/approve
{ "refund_amount": ..., "review_note": "..." }
```

**注意**（G12）：
- service 层已 FOR UPDATE 锁 + DB UNIQUE 兜底
- 双击 approve 不会双扣提成
- 遇到 `uq_commission_adjustment_source` 违例 **不要重试**

**驳回**：
```
POST /api/mall/admin/returns/{id}/reject
{ "review_note": "..." }
```

**标记已退款**（批准后的资金结算）：
```
POST /api/mall/admin/returns/{id}/mark-refunded
{ "refund_method": "wechat|bank|cash|alipay", "refund_amount": ... }
```

**权限**：admin / boss / finance。

### 13. 门店零售退货待审（桥 B12）

```
GET /api/store-returns?status=pending
GET /api/store-returns/pending-approval       # 审批中心聚合端点
```

**批准**（条码回 in_stock + 库存回加 + commission 冲销或 adjustment）：
```
POST /api/store-returns/{id}/approve
```

**驳回**（必传 rejection_reason）：
```
POST /api/store-returns/{id}/reject
{ "rejection_reason": "..." }
```

**权限**：admin / boss / finance。同 G12 并发保护。

### 14. 仓库调拨审批（桥 B11）

```
GET /api/transfers/pending-approval
```

**批准 / 驳回**：
```
POST /api/transfers/{id}/approve
POST /api/transfers/{id}/reject
```

**执行**（批准后的实际过户）：
```
POST /api/transfers/{id}/execute
```

**权限**：admin / boss / finance。仅跨品牌 / 涉 mall / 跨端调拨需审批。

---

## Agent 的审批中心聚合场景

用户（老板/财务）说"看一下今天有啥要审的"：

Agent 并行调：
```python
orders_pending = GET /api/orders/pending-receipt-confirmation
policies_pending = GET /api/orders?status=policy_pending_internal
purchases_pending = GET /api/purchase-orders?status=pending
transfers_pending = GET /api/accounts/pending-transfers
salaries_pending = GET /api/payroll/salary-records?status=pending_approval
leaves_pending = GET /api/attendance/leave-requests?status=pending
...
```

按用户当前角色过滤（salesman 不看这些）。

然后推一张**汇总卡片**：

```json
{
  "header": {"title": {"tag": "plain_text", "content": "审批中心 (4 月 26 日)"}, "template": "orange"},
  "elements": [
    {"tag": "div", "text": {"tag": "lark_md", "content":
      "**待处理 (12)**\n\n"
      "📝 收款确认：**5** 单（¥58,000）[查看]\n"
      "🎯 政策审批：**3** 单 [查看]\n"
      "🛒 采购审批：**2** 单（¥120,000）[查看]\n"
      "💰 调拨申请：**1** 笔（¥50,000）[查看]\n"
      "👤 请假申请：**1** 条 [查看]"
    }},
    {"tag": "action", "actions": [
      {"tag": "button", "text": {"tag": "plain_text", "content": "按顺序处理"},
       "type": "primary", "value": {"action": "approval_next"}},
      {"tag": "button", "text": {"tag": "plain_text", "content": "稍后"},
       "type": "default", "value": {"action": "cancel"}}
    ]}
  ]
}
```

用户点"按顺序处理" → Agent 推第一个待审项的详情卡片（带批准/拒绝按钮）→ 处理完自动推下一个。

## 单个审批卡片通用模板

```json
{
  "header": {"title": {"tag": "plain_text", "content": "<类型> 审批"}, "template": "blue"},
  "elements": [
    {"tag": "div", "text": {"tag": "lark_md", "content": "<内容摘要，见下各场景>"}},
    {"tag": "action", "actions": [
      {"tag": "button", "text": {"tag": "plain_text", "content": "批准"},
       "type": "primary", "value": {"action": "approve", "entity_type": "...", "entity_id": "..."}},
      {"tag": "button", "text": {"tag": "plain_text", "content": "驳回"},
       "type": "danger", "value": {"action": "reject", "entity_type": "...", "entity_id": "..."}},
      {"tag": "button", "text": {"tag": "plain_text", "content": "跳过"},
       "type": "default", "value": {"action": "skip"}}
    ]}
  ]
}
```

驳回要让用户输入理由 → Agent 推表单卡片问"驳回原因"。

## 各场景的摘要模板

### 收款确认

```markdown
**订单**：SO-2026042609 张三烟酒店
**应收**：¥27,000（customer_pay）
**本次凭证**：¥27,000（全款）
**上传时间**：2026-04-26 10:30
**凭证**：[图 1] [图 2]
**操作**：
- 批准 → 进 master 现金，生成提成 ¥1,080
- 驳回 → 业务员重传凭证
```

### 政策审批

```markdown
**订单**：SO-20260426 张三烟酒店 5 箱青花郎
**政策**：VIP 5-10 箱，赠品 1 箱 + 返现 ¥500
**公司让利总额**：¥2,000
**垫付人**：业务员李四
**操作**：批准 → 解锁出库
```

### 采购审批

```markdown
**采购单**：PO-2026042601
**供应商**：郎酒集团
**品牌**：青花郎
**付款**：现金 ¥50,000（现金账户余额 ¥123K ✅）
**商品**：青花郎 53 度 500ml × 100 瓶（¥500/瓶）
**目标仓**：青花郎主仓
```

### 调拨审批

```markdown
**从**：Master 现金（余额 ¥500K）
**到**：青花郎现金（当前 ¥23K）
**金额**：¥100,000
**理由**：4 月发工资
**申请人**：财务张三
```

### 工资审批

```markdown
**员工**：业务员李四（主属青花郎）
**月份**：2026-04
**底薪** ¥5,000 + **全勤** ¥300 + **提成** ¥2,400 - **罚款** ¥100
**应发**：¥7,600
**品牌现金账户余额**：¥123K（充足 ✅）
```

### 请假审批

```markdown
**员工**：业务员李四
**类型**：病假
**时间**：2026-04-27 ~ 2026-04-29（3 天）
**理由**：感冒发烧
**证明**：[图]
**影响**：当月迟到扣款可能增加
```

### 垫付返还审批

```markdown
**申请人**：业务员李四
**事由**：政策垫付（订单 SO-xxx 赠送青花郎 1 箱）
**金额**：¥500
**从账户**：青花郎现金（余额 ¥123K）
```

## 驳回后的通知

Agent 处理完驳回后，推通知给原申请人：

```json
{
  "header": {"title": {"tag": "plain_text", "content": "❌ 你的 <xxx> 被驳回"}, "template": "red"},
  "elements": [
    {"tag": "div", "text": {"tag": "lark_md", "content":
      "**<实体名>** <编号>\n"
      "**原因**：<填的理由>\n"
      "**下一步**：请修改后重新提交"
    }}
  ]
}
```

## Agent 主动推送触发

后端关键动作产生新待审时，通过 notification / webhook 通知 Agent：

| 产生事件 | Agent 推给谁 |
|---|---|
| 上传收款凭证 | finance / boss |
| 订单提交政策审批 | boss |
| 建采购单 | finance / boss |
| 建调拨 | boss |
| 建工资单批量 | boss / hr |
| 建请假 | hr（再转 boss 如超阈值）|
| 政策垫付 fulfilled | finance |
| 大额报销 | boss |
| 融资还款提交 | finance |

## 权限快速对照

| 角色 | 能审 |
|---|---|
| salesman / sales_manager | ❌（只能提交，不能批） |
| warehouse | 仅仓库相关的（退货、损耗） |
| finance | 收款 / 采购 / 调拨（二审）/ 工资（二审）/ 报销（小额）/ 融资 / 垫付返还 |
| hr | 工资（一审）/ 请假（一审）/ 绩效 |
| boss | 全部（最终审批人） |
| admin | 全部（含系统管理） |

**Agent 对非权限角色**：不要推审批卡片。直接在审批中心聚合卡片里过滤掉"无权审批"的项。

## 批量审批

```
POST /api/payroll/salary-records/batch-submit
POST /api/payroll/salary-records/batch-confirm
POST /api/payroll/salary-records/batch-pay
```

工资是主要批量场景（一个月几十人）。Agent 可推"批量审批"卡片让 boss 一键批准本月所有 approved 的。**但 batch-pay 建议一条一条确认**——发钱的动作太敏感。

## 关键禁忌

- ❌ Agent **不能自动审批**。哪怕用户是 boss 本人，也必须让他点按钮。
- ❌ Agent **不能把驳回理由替用户想**。问用户填。
- ❌ Agent **不能跳过必审项**（如大额采购）强推用户批。
- ❌ 收款确认是**all-or-nothing**，Agent 不要说"只确认这一条凭证"——不支持，会被后端拒绝。
