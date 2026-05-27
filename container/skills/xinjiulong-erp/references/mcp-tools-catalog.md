# MCP 工具目录（Agent 可调工具清单）

**这份文档的角色**：告诉 Agent 有哪些 MCP tool 可以调、每个工具做什么、需要什么角色、参数名中文含义。

**实际源**：`backend/app/mcp/catalog.py`（94 个 tool）。本文档按业务场景分组，方便 Agent 快速查。

**核心原则**：
- ✅ **薄壳化完成**（2026-04-29 Phase 1-3）：所有写入类 MCP tool 现在都薄壳调 HTTP 真身 handler，逻辑和前端 100% 一致
- ❌ **废弃**：`fulfill-policy-materials` / 旧版 `confirm-policy-arrival` / 旧版 `confirm-policy-fulfill` — 这些工具语义错误，catalog 已移除，不再暴露给 Agent
- ✅ **name/code/UUID 都能传**：customer_id / product_id / salesman_id 等引用字段，Agent 传中文名就行（`"张三烟酒店"` / `"青花郎53度500ml"`），MCP 自动解析

---

## 身份机制（所有工具共用）

Agent 调 MCP tool 时必须带 `_open_id`（飞书用户 open_id）。MCP bridge 用它换**该员工本人**的短期 JWT（15 分钟 TTL），带 role / brand_ids / employee_id。

- ❌ 禁止跨用户复用 JWT
- ❌ 禁止用 admin 万能 token 代 salesman 查数据
- ✅ salesman 硬绑定：传 `salesman_id=admin_id` 会被 HTTP 层覆盖成自己
- ✅ CBS 归属校验：salesman 用未绑定品牌的客户建单 → 400 "客户不存在或未绑定到你名下"

详见 `business-rules.md` §零。

---

## 一、销售订单全链路（13 个工具）

### 建单前（查询）

| Tool | 谁能调 | 干嘛 |
|---|---|---|
| `query-customers` | 所有员工 | 查客户列表（按关键字/品牌） |
| `query-products` | 所有员工 | 查商品（按品牌/关键字） |
| `query-policy-templates` | 所有员工 | 查政策模板（含指导价/到手价） |
| `query-brands` | 所有员工 | 查品牌 |

### 建单（薄壳 → HTTP）

| Tool | 谁能调 | 干嘛 | 对齐 HTTP |
|---|---|---|---|
| `preview-order` | salesman/boss/manager/finance | 预览订单金额（不持久化）。建单前**必须先调**让用户确认 | `POST /api/orders/preview` |
| `create-order` | salesman/boss/manager | 建单原子接口：Order+PolicyRequest+submit-policy 一次完成，status → policy_pending_internal | `POST /api/orders/create-with-policy` |
| `update-order` | salesman/boss/manager | 编辑订单（仅 pending 状态） | `PUT /api/orders/{id}` |
| `submit-order-policy` | salesman/boss/manager | 手工提交政策审批（pending → policy_pending_internal）。一般不用，create-order 自动做 | `POST /api/orders/{id}/submit-policy` |
| `resubmit-order` | salesman/boss/manager | 被驳回订单重新提交（policy_rejected → pending） | `POST /api/orders/{id}/resubmit` |

### 审批（boss 专属，薄壳）

| Tool | 谁能调 | 干嘛 | 对齐 HTTP |
|---|---|---|---|
| `approve-order` | boss | 政策审批（action=approve/reject 二选一）。合并更新 Order.status + PolicyRequest.status | `POST /api/orders/{id}/approve-policy-with-request` 或 `reject-...` |
| `reject-order-policy` | boss | 单独驳回（legacy，用 approve-order 即可） | `POST /api/orders/{id}/reject-policy-with-request` |

### 履约 / 收款（薄壳）

| Tool | 谁能调 | 干嘛 | 对齐 HTTP |
|---|---|---|---|
| `update-order-status` | salesman/warehouse/boss | ship / confirm-delivery / cancel | `POST /api/orders/{id}/ship` 等 |
| `upload-payment-voucher` | salesman/boss/manager | **业务员上传收款凭证**（pending，不动账）等财务审批 | `POST /api/orders/{id}/upload-payment-voucher` |
| `register-payment` | finance/boss | **财务直录收款**（立即 confirmed + 动 master 账户） | `POST /api/receipts` |
| `confirm-order-payment` | finance/boss | 财务批准订单所有 pending 凭证：动账 + 提成生成 + KPI 刷新 + 里程碑 | `POST /api/orders/{id}/confirm-payment` |
| `reject-payment-receipts` | finance/boss | 财务驳回所有 pending 凭证（带原因，通知业务员重传） | `POST /api/orders/{id}/reject-payment-receipts` |
| `complete-order` | finance/boss | delivered → completed（不要求 fully_paid） | `POST /api/orders/{id}/complete` |

---

## 二、政策兑付全链路（6 个工具，Phase 3 新增）

| Tool | 谁能调 | 干嘛 | 对齐 HTTP |
|---|---|---|---|
| `fulfill-materials` | finance/boss | 政策物料出库（从品鉴仓扣库存 + 更新 item.fulfill_status） | `POST /policies/requests/{id}/fulfill-materials` |
| `fulfill-item-status` | finance/boss | 更新 item 状态（applied/fulfilled/settled） | `POST /policies/requests/{id}/fulfill-item-status` |
| `submit-policy-voucher` | finance/boss/salesman | 提交兑付凭证（arrived/settled → fulfilled） | `POST /policies/requests/{id}/submit-voucher` |
| `confirm-fulfill` | finance/boss | 财务归档（fulfilled → settled，进利润台账）幂等 | `POST /policies/requests/{id}/confirm-fulfill` |
| `confirm-policy-arrival` | finance/boss | 批量确认政策到账（item 级 + F 类账户加钱）幂等 | `POST /policies/requests/confirm-arrival` |
| `create-policy-request` | finance/boss/salesman/manager | 按已激活模板手工建政策申请，明细自动带出（额外费用不要走这里） | `POST /policies/requests` |

**场景典型顺序**：
1. 订单 completed 后 → 业务员调 `fulfill-materials` 把政策赠品出库给客户
2. 业务员拿到厂家凭证后 → 调 `submit-policy-voucher` 上传
3. 财务 → 调 `confirm-fulfill` 归档
4. 厂家打款到账 → 财务调 `confirm-policy-arrival` 入 F 类账户

---

## 三、稽查（4 个工具）

| Tool | 谁能调 | 干嘛 | 对齐 HTTP |
|---|---|---|---|
| `create-inspection-case` | finance/boss | 建案（自动算 profit_loss） | `POST /inspection-cases` |
| `approve-inspection` | finance/boss | action=approve 推到 approved；action=execute 执行（扣账户+动库存） | `PUT /inspection-cases/{id}` + `/execute` |
| `close-inspection-case` | finance/boss | executed → closed（归档进利润台账） | `PUT /inspection-cases/{id}` status=closed |
| `create-market-cleanup-case` | finance/boss | 建市场清理案 | (独立路径) |

**典型顺序**：create → approve → execute → close。

---

## 四、采购（4 个工具）

| Tool | 谁能调 | 干嘛 | 对齐 HTTP |
|---|---|---|---|
| `create-purchase-order` | purchase/warehouse/boss | 建采购单（含明细），status pending | `POST /purchase-orders` |
| `approve-purchase-order` | finance/boss | approve → approved+付款；reject → cancelled | `POST /purchase-orders/{id}/approve/reject` |
| `receive-purchase-order` | warehouse/purchase/boss | 收货（扣 PO 款，入库 StockFlow + Inventory），需传 batch_no | `POST /purchase-orders/{id}/receive` |
| `cancel-purchase-order` | purchase/boss | 撤销已付款采购单（反扣账户），仅 paid 状态可撤销 | `POST /purchase-orders/{id}/cancel` |

---

## 五、财务 / 资金（7 个工具）

| Tool | 谁能调 | 干嘛 | 对齐 HTTP |
|---|---|---|---|
| `query-account-balances` | finance/boss | 查各品牌账户余额（master/cash/F类/financing/payment_to_mfr） | `GET /accounts` |
| `query-fund-flows` | finance/boss | 查资金流水（按账户/类型/时间） | `GET /fund-flows` |
| `create-fund-transfer-request` | finance/boss | 发起调拨申请（不立即执行） | `POST /accounts/transfer` |
| `approve-fund-transfer` | boss | 批准调拨（执行：from -= amount, to += amount） | `POST /accounts/transfers/{id}/approve` |
| `reject-fund-transfer` | boss | 驳回调拨申请 | `POST /accounts/transfers/{id}/reject` |
| `submit-financing-repayment` | finance/boss | 提交融资还款（含利息） | `POST /financing-orders/repayments` |
| `approve-financing-repayment` | boss | 批还款（扣现金 + F 类可选） | `POST /financing-orders/repayments/{id}/approve` |

---

## 六、工资 / 提成 / 绩效（9 个工具）

| Tool | 谁能调 | 干嘛 | 对齐 HTTP |
|---|---|---|---|
| `query-salary-records` | hr/finance/boss | 查工资单 | `GET /payroll/salary-records` |
| `generate-salary` | hr/finance/boss | 生成本期工资单（按员工×期） | `POST /payroll/salary-records/generate` |
| `batch-submit-salary` | hr/boss | 批量提交本期工资单审批 | `POST /payroll/salary-records/batch-submit` |
| `approve-salary` | finance/boss | 审批工资单 | `POST /payroll/salary-records/{id}/approve` |
| `pay-salary` | finance/boss | 发放工资（扣品牌现金） | `POST /payroll/salary-records/{id}/pay` |
| `settle-commission` | hr/finance/boss | 提成结算 | `POST /commissions/settle` |
| `query-commissions` | hr/finance/boss/salesman | 查提成 | `GET /commissions` |
| `generate-subsidy-expected` | finance/boss | 生成厂家工资补贴应收 | `POST /payroll/manufacturer-subsidies/generate` |
| `confirm-subsidy-arrival` | finance/boss | 确认厂家补贴到账（动品牌 cash） | `POST /payroll/manufacturer-subsidies/confirm-arrival` |
| `create-salary-scheme` | hr/boss | upsert 薪酬方案（品牌×岗位） | `POST /payroll/brand-salary-schemes` |

---

## 七、客户 / 员工 / 商品 / 供应商（10 个工具）

| Tool | 谁能调 | 干嘛 |
|---|---|---|
| `create-customer` | salesman/boss/manager | 建客户 + CBS 绑定 |
| `update-customer` | salesman/boss/manager | 编辑客户 |
| `bind-customer-brand-salesman` | salesman/boss/manager | 建/改 CBS 关系 |
| `query-employees` | hr/finance/boss/manager | 查员工 |
| `create-employee` | hr/boss | 建员工档案 |
| `update-employee` | hr/boss | 改员工信息 |
| `bind-employee-brand` | hr/boss | 员工 × 品牌 × 岗位 绑定（设提成率/补贴/主属品牌） |
| `create-user` | boss | 建登录账号（username/password/role） |
| `create-product` | warehouse/boss | 建商品 |
| `create-supplier` | purchase/warehouse/boss | 建供应商 |

---

## 八、请假 / 考勤 / 报销（5 个工具）

| Tool | 谁能调 | 干嘛 |
|---|---|---|
| `create-leave-request` | 所有员工 | 提请假 |
| `approve-leave` | hr/boss | 审请假 |
| `create-expense` | finance/boss | 建费用 |
| `approve-expense` | finance/boss | 审费用（approve/reject/pay） |
| `approve-expense-claim` | finance/boss | 审报销（approve/reject/pay） |
| `query-attendance-summary` | hr/boss | 查月度考勤 |
| `query-leave-requests` | hr/boss/salesman | 查请假 |
| `query-expense-claims` | finance/boss | 查报销 |

---

## 九、库存 / 销售目标 / 利润（6 个工具）

| Tool | 谁能调 | 干嘛 |
|---|---|---|
| `query-inventory` | 大部分角色 | 查库存（含低库存预警） |
| `query-warehouses` | 大部分角色 | 查仓库 |
| `query-profit-summary` | finance/boss/manager | 利润台账 11 科目 |
| `query-sales-targets` | 销售链条 | 查销售目标完成率 |
| `create-sales-target` | boss/manager | 建销售目标 |
| `approve-sales-target` | boss/manager | 审销售目标 |

---

## 十、政策理赔（4 个工具）

| Tool | 谁能调 | 干嘛 |
|---|---|---|
| `create-policy-claim` | finance/boss | 建 PolicyClaim |
| `approve-policy-claim` | finance/boss | 审 PolicyClaim |
| `confirm-settlement-allocation` | finance/boss | 确认厂家结算分配到 claim |
| `create-manufacturer-settlement` | finance/boss | 建厂家结算到账记录，并同步记入品牌 F 类账户 |

---

## 十一、legacy / 特殊工具（6 个）

| Tool | 备注 |
|---|---|
| `create-order-from-text` | 用自然语言建单（会 NLP 解析），一般别用，走标准 create-order |
| `query-barcode-tracing` | 条码追溯（产品→批次→订单→客户） |
| `submit-policy-approval` | 提交政策申请审批（和 create-order 重复） |
| `create-policy-usage-record` | 手工建政策使用记录（非出货场景，如品鉴） |
| `push-manufacturer-update` | 推厂家动态通知 |
| `allocate-settlement-to-claims` | 预览结算分配（只算不写） |

---

## 怎么找对的工具

用户说的 → 用什么 tool：

| 员工说 | 调什么 tool |
|---|---|
| "给张三下 5 箱青花郎" | 先 `preview-order`，后 `create-order` |
| "SO-xxx 客户打款了，凭证是 xxx" | `upload-payment-voucher` |
| "批了 SO-xxx 的政策" | `approve-order`（action=approve） |
| "驳回 SO-xxx，价格太低" | `approve-order`（action=reject）或 `reject-order-policy` |
| "财务确认 SO-xxx 的收款" | `confirm-order-payment` |
| "这单送到了，有照片" | `update-order-status`（action=confirm-delivery） |
| "查一下我本月业绩" | `query-sales-targets` 或 `query-commissions` |
| "向郎酒采购 100 箱" | `create-purchase-order` |
| "采购单 PO-xxx 收到货了" | `receive-purchase-order` |
| "青花郎现在多少钱" | `query-account-balances?brand=青花郎` |
| "请病假 4/26-4/28" | `create-leave-request` |
| "报销 ¥500 出差" | `create-expense` 或 `approve-expense-claim` |
| "稽查云南窜货 ABC123" | `create-inspection-case` → `approve-inspection` action=approve → action=execute → `close-inspection-case` |
| "政策赠品给张三了" | `fulfill-materials` |
| "厂家政策款 ¥500 到账" | `confirm-policy-arrival` |
| "调 10 万从 master 到青花郎" | `create-fund-transfer-request` → boss 批 `approve-fund-transfer` |
| "生成 4 月工资" | `generate-salary` |

---

## Agent 操作守则（每次调 tool 前都要做）

1. **查询类**（query-*）直接调，不用卡片确认
2. **写入类**（create- / update- / approve- / confirm- / reject- / pay-）**必须先推卡片**，用户点"确认"按钮再调
3. **金额永远用 preview-order 返回**，不自己算
4. **动账接口超时不自动重试**：等 5 秒 → 调 query-orders 等查状态 → 确认成功不重试
5. **错误消息原样展示**，不自己解释
6. **salesman 绝不看 master 账户余额**（RLS 已强制，但 Agent 也要在展示层脱敏）
