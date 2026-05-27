# MCP Agent 剧本（MCP 视角）

**用途**：Agent 听到员工一句话 → 翻译成 MCP tool 调用序列。对应 `mcp-tools-catalog.md`。

**相对 `agent-playbook.md` 的关系**：旧版用 HTTP 视角写的，适合前端开发看；本文档用 MCP tool 视角写，适合通过 openclaw / MCP 客户端调用的 agent 看。**Agent 优先看这份**。

---

## 通用流程（所有场景共用）

```
员工说话
  │
  ▼
识别意图（关键词匹配）→ 查 mcp-tools-catalog.md 找对的 tool
  │
  ▼
【查询类】直接调 query-* tool → 展示结果
【写入类】
  1. 调 query-* 或 preview-* tool 拿展示数据 / 金额
  2. 推飞书卡片（含完整摘要 + 确认按钮）
  3. 用户点"确认" → 飞书回调 card.action.trigger
  4. 调写入类 tool（create-/approve-/confirm-）
  5. update_card 改成"✅ 已完成"
```

**铁律**：
- 所有 MCP tool 调用**必须带 `_open_id`**（openclaw 会自动从飞书 sender 注入）
- 写入类调用**必须卡片按钮点击**（不依赖"打字确认"）
- **金额字段永远用 preview-order 返回值**，不自己算
- **超时不重试动账接口**

---

## 场景 1：建客户

**员工话术**："帮我建张三烟酒店这个客户" / "新客户王五便利店"

**步骤**：
1. 收集必填字段（缺则问）：`name / customer_type / settlement_mode / brand_id / contact_name / contact_phone`
2. salesman 建单时 `brand_id` **必传**（从 `query-brands` 让用户选）
3. 推卡片摘要确认
4. 调：
   ```
   tool: create-customer
   args: {
     name: "张三烟酒店",
     customer_type: "channel",
     settlement_mode: "cash",
     brand_id: "青花郎",        // 支持中文名
     contact_name: "张三",
     contact_phone: "13800000001"
   }
   ```
5. 后端自动建 CustomerBrandSalesman 把客户绑到当前 salesman

---

## 场景 2：建单（核心场景）

**员工话术**："给张三下 5 箱青花郎，客户按指导价付" / "李四这单 10 箱五粮液，业务员垫差"

**步骤**：

### 2.1 收集参数
- `customer_id` 客户（传名字就行）
- `items[]` 商品 + 箱数
- `settlement_mode` **必问**：customer_pay / employee_pay / company_pay
- `advance_payer_id` 仅 employee_pay 模式需要（垫付业务员）

### 2.2 先 preview
```
tool: preview-order
args: {
  customer_id: "张三烟酒店",
  items: [{product_id: "青花郎53度500ml", quantity: 5, quantity_unit: "箱"}],
  settlement_mode: "customer_pay"
}
→ 返回 {total_amount: 27000, deal_amount: 25500, policy_gap: 1500,
        customer_paid_amount: 27000, policy_template: "..."}
```

### 2.3 推卡片给用户确认
```
【确认建单】
客户：张三烟酒店
品牌：青花郎
结算：客户按指导价付（customer_pay）
商品：青花郎 53度 500ml × 5 箱
政策：青花郎 5 箱基础政策 TPL-QHL-5
指导价总额：¥27,000
客户实付：¥27,000
公司应收：¥27,000

[确认建单]  [取消]
```

### 2.4 用户点"确认建单"→ 调
```
tool: create-order
args: {同 preview 参数}
→ 返回 {order_no: "SO-xxx", status: "policy_pending_internal", ...}
```

### 2.5 反馈
```
✅ 订单已建 SO-xxx
已进入内部审批流程，等老板审批
```

**注意**：`create-order` 现在**事务化一次完成**Order + PolicyRequest + submit-policy 三步。不需要 agent 再调 `submit-order-policy`。

---

## 场景 3：老板审批订单

**员工话术**（boss 说）："批了 SO-xxx" / "驳回，价格太低"

**步骤**：
1. 先调 `query-orders` 拉待审订单列表展示
2. 推确认卡片
3. boss 点"批准"或"驳回"：

```
tool: approve-order
args: {
  order_no: "SO-xxx",
  action: "approve",        // 或 "reject"
  reject_reason: "...",     // 仅 reject 时
  need_external: false      // 是否推到厂家外审
}
```

这一个 tool 同时更新 `Order.status` + `PolicyRequest.status`（合并 HTTP 两步为一事务）。

---

## 场景 4：出库 / 送达

**员工话术**（仓管/业务员）："SO-xxx 出库" / "货送到了"

**出库**（warehouse）：
```
tool: update-order-status
args: { order_no: "SO-xxx", action: "ship" }
```
**建议**：实际扫码出库走前端页面 `/orders/{id}/stock-out`，agent 这里只做非扫码的简单场景。

**送达**（salesman）：
```
tool: update-order-status
args: { order_no: "SO-xxx", action: "confirm-delivery" }
```

---

## 场景 5：上传收款凭证（salesman 最常用）

**员工话术**："SO-xxx 客户打款了，凭证在我手机上"

**步骤**：
1. 回复文本："请把收款凭证图片直接发给我"
2. 用户发图 → Agent 收 `im.message.receive_v1` 提取 `image_key`
3. Agent 调飞书 API 下载图片 → POST 到 ERP `/api/uploads` 拿 URL（这步不走 MCP）
4. 问金额："本次收多少？全款还是部分？"
5. 推确认卡片
6. 点击后：
```
tool: upload-payment-voucher
args: {
  order_no: "SO-xxx",
  amount: 27000,
  voucher_urls: ["/api/uploads/files/2026-04/xxx.jpg"],
  source_type: "customer"
}
→ 建 pending_confirmation Receipt，不动账
```
7. 反馈："凭证已提交，等财务审批（1-2 小时内）。审批通过后才算真正入账 + 生成提成"

**和 `register-payment` 的区别**：`register-payment` 是财务直录（立即动账），业务员路径用 `upload-payment-voucher`。

---

## 场景 6：财务审批收款

**员工话术**（finance）："张三的 SO-xxx 批了" / "驳回凭证金额不对"

**列表**：
```
tool: query-orders
args: { payment_status: "pending_confirmation" }
```

**批准**（批准此订单所有 pending 凭证）：
```
tool: confirm-order-payment
args: { order_no: "SO-xxx" }
→ 所有 pending Receipt → confirmed
→ master 现金池 += 每笔
→ 首次 fully_paid 时生成 Commission / 刷 KPI / 推里程碑
```

**驳回**：
```
tool: reject-payment-receipts
args: { order_no: "SO-xxx", reason: "金额对不上" }
→ 所有 pending Receipt → rejected
→ 通知业务员重传
```

---

## 场景 7：查询类（全自动，不要卡片）

| 员工说 | 调 | 展示 |
|---|---|---|
| "我本月回款多少" | `query-commissions` + `query-sales-targets` | 实发提成 + 目标完成率 |
| "SO-xxx 现在啥状态" | `query-order-detail` | 订单状态 + 付款状态 + 已收/欠 |
| "青花郎还有多少库存" | `query-inventory?brand=青花郎` | 产品×仓库×批次×数量 |
| "青花郎账户" | `query-account-balances?brand=青花郎` | 品牌 cash/F类/financing 余额 |
| "李四 4 月工资" | `query-salary-records?employee_id=李四&period=2026-04` | 底薪/提成/奖金/扣款/实发 |
| "今天有啥要审" | 并行调多个 query-* + 聚合 | 审批中心汇总卡片 |

---

## 场景 8：政策兑付链路（4 步）

**员工话术**："SO-xxx 政策赠品给客户了" → "凭证发你" → 财务归档 → 厂家款到

**4 步**：

### 8.1 物料出库（业务员）
```
tool: fulfill-materials
args: {
  request_id: "<PolicyRequest UUID>",
  items: [{
    product_id: "青花郎53度500ml",
    quantity: 1,
    quantity_unit: "箱",
    request_item_id: "<PolicyRequestItem UUID>"
  }]
}
→ 从品鉴仓扣库存 + item.fulfill_status=applied/fulfilled
```

### 8.2 提交凭证（业务员）
```
tool: submit-policy-voucher
args: {
  request_id: "...",
  item_id: "...",
  voucher_urls: ["/api/uploads/..."]
}
→ item.fulfill_status=fulfilled
```

### 8.3 财务归档
```
tool: confirm-fulfill
args: { request_id: "...", item_id: "..." }
→ item.fulfill_status=settled，进利润台账
```

### 8.4 厂家到账（财务）
```
tool: confirm-policy-arrival
args: {
  items: [{
    item_id: "<PolicyRequestItem UUID>",
    arrived_amount: 500,
    billcode: "银行单号"
  }]
}
→ 补写 item arrival_amount/arrival_at；applied 会推进到 arrived，fulfilled/settled 保持原兑付状态；历史 F 类条目会同步记入 F 类账户
```

---

## 场景 9：稽查案件（4 步）

**员工话术**（业务员）："我在云南发现窜货，条码 ABC123"

**1. 追溯**：`query-barcode-tracing` ABC123 → 拿 original_order_id / customer / prices

**2. 建案**：
```
tool: create-inspection-case
args: {
  case_type: "outflow_malicious",    // A1恶意 / A2非恶意 / A3被转码 / B1回售 / B2转码入
  direction: "outflow",
  brand_id: "青花郎",
  product_id: "青花郎53度500ml",
  barcode: "ABC123",
  quantity: 2, quantity_unit: "箱",
  purchase_price: 700, penalty_amount: 10000,
  ...
}
```

**3. 审批 + 执行**（boss）：
```
tool: approve-inspection
args: { case_id: "<UUID 或 case_no>", action: "approve" }
→ pending → approved

tool: approve-inspection
args: { case_id: "...", action: "execute" }
→ approved → executed，扣品牌现金 + 动库存
```

**4. 归档**：
```
tool: close-inspection-case
args: { case_id: "..." }
→ executed → closed，进利润台账
```

---

## 场景 10：采购 + 收货

**员工话术**：
- "向郎酒集团采购青花郎 100 瓶" → `create-purchase-order`
- "批采购单 PO-xxx" → `approve-purchase-order` action=approve
- "PO-xxx 收到货了" → `receive-purchase-order`（需 batch_no）
- "撤销 PO-xxx 付款" → `cancel-purchase-order`（仅 paid 状态）

---

## 场景 11：调拨 + 还款

**员工话术**：
- "从 master 调 10 万到青花郎现金" →
   1. `create-fund-transfer-request` 建申请
   2. boss 审批 → `approve-fund-transfer`

**还融资**：
1. `submit-financing-repayment` 业务员提交
2. `approve-financing-repayment` boss 批（action=approve/reject）

---

## 场景 12：请假 / 报销

**请假**：
```
tool: create-leave-request
args: { leave_type: "sick", start_date: "...", end_date: "...", total_days: 3, reason: "..." }
```
HR 审批：`approve-leave`

**报销**：
```
tool: create-expense
args: { amount: 500, category: "差旅", ... }
```
财务 3 个动作：`approve-expense`（approve/reject/pay）

---

## 场景 13：工资 / 提成

**HR 生成工资**：
```
tool: generate-salary
args: { period: "2026-04" }
```

**查工资**：`query-salary-records`

**审批**：`approve-salary`

**发放**：`pay-salary`（扣品牌现金）

**厂家补贴到账**：`confirm-subsidy-arrival`（严格金额校验，自动核销）

---

## 场景 14：Agent 不确定时的兜底

用户说话模糊 / Agent 识别不出意图：

**标准回复**（不能猜意图直接调接口）：
```
没太明白你要做什么。你可以说：
- 建客户 / 查客户
- 建订单 / 查订单 / 批订单
- 上传凭证 / 确认收款
- 查库存 / 查账户 / 查工资
- 查本月业绩
- 稽查 / 请假 / 报销

你想做哪一个？
```

---

## 总原则（Agent 每次都要遵守）

1. ✅ **查询类直接调**，写入类必须卡片按钮确认
2. ✅ **金额永远用 preview-order 返回**，不自己算
3. ✅ **动账失败不自动重试**
4. ✅ **错误消息原样展示**，不自己解释 detail
5. ✅ **salesman 永远不看 master 账户余额**（RLS + 展示层脱敏双重保护）
6. ✅ **多图上传等 30 秒静默**或用"完成上传"按钮明确结束
7. ✅ **不替用户审批**（boss 本人也要在飞书卡片点按钮，不是打字"批了"）
8. ✅ **时间按东八区展示**
9. ✅ **对话记忆 ≤ 10 轮**，超过引导用户重新说明
10. ✅ **永远用员工本人 JWT**（bridge 按 open_id 换 token，不跨用户复用）

---

## 参考

- 工具清单：`mcp-tools-catalog.md`
- 业务规则：`business-rules.md`（权限矩阵 / 身份隔离 §零）
- 状态机：`state-machines.md`
- 字段语义：`field-semantics.md`
- 资金流向：`fund-flows-catalog.md`
- 坑位总结：`pitfalls.md`
- 旧版 HTTP 剧本：`agent-playbook.md`（兼容用，新写的走本文档）
