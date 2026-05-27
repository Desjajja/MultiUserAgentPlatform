# 端点风险分级（Endpoint Risk Levels）

按业务场景把所有写入端点（POST/PUT/DELETE/PATCH）分到 L0 / L1 / L2 三档。
这是阶段 0 的基础——AI 网关、二次确认 token、批量限额都靠这份清单决定哪些
端点要严管、哪些可直通。

**整体统计**：300 个写入端点 · L0 ≈ 218 · L1 ≈ 56 · **L2 = 25**

---

## L2 高敏（38 条，必须 AI 网关拦截 + 二次确认）

来源：动账 / 跨模块时序 / 批量放大 / 强写状态 / 直接动数据 / 关键审计反向。

| # | 端点 | 文件:行 | 业务影响 |
|---|---|---|---|
| 1 | POST `/api/orders/{id}/confirm-payment` | orders.py:1319 | 动账：进 master 现金池 + 写 Commission + 应收清零 |
| 2 | POST `/api/orders/{id}/reject-payment-receipts` | orders.py:1443 | 关键审计/反向动账：Receipt 作废、提成抹除、订单状态回退 |
| 3 | PUT  `/api/finance/payment-requests/{id}` | finance.py:1600 | **强推状态机**：可直接改 `status=approved` 越过审批 UI |
| 4 | POST `/api/finance/payment-requests/{id}/confirm-payment` | finance.py:1657 | 动账：出品牌现金账户 |
| 5 | POST `/api/finance/expenses/{id}/pay` | finance.py:637 | 动账：报销付款扣品牌现金 |
| 6 | POST `/api/finance/manufacturer-settlements/{id}/allocation-confirm` | finance.py:826 | 跨模块 + 动账：F 类到账分摊到品牌账户 |
| 7 | POST `/api/finance/manufacturer-settlements/apply-reconcile` | finance.py:1257 | **批量 + 动账**：Excel 批量对账后批量动账 |
| 8 | POST `/api/accounts/transfer` | accounts.py:182 | 动账：跨账户调拨建单 |
| 9 | POST `/api/accounts/transfers/{id}/approve` | accounts.py:257 | 动账：真正改账户余额 |
| 10 | POST `/api/accounts/fund-flows` | accounts.py:590 | **直接动数据**：直接写资金流水，可绕业务建账 |
| 11 | POST `/api/policies/request-items/{id}/expenses` | policies.py:983 | 动账（payer=company 立扣品牌现金）|
| 12 | POST `/api/policies/requests/confirm-arrival` | policies.py:1269 | 动账：F 类政策资金确认到账 |
| 13 | POST `/api/policies/requests/{id}/confirm-fulfill` | policies.py:1414 | **跨模块时序**：依赖订单 completed，触发 PolicyClaim |
| 14 | POST `/api/policies/claims/{id}/approve` | policies.py:1452 | 关键审计 + 动账：政策兑付审批通过 |
| 15 | POST `/api/inspections/inspection-cases/{id}/execute` | inspections.py:398 | 跨模块 + 动账：扣品牌现金、进利润台账 |
| 16 | POST `/api/transfers/{id}/execute` | transfers.py:248 | 跨模块：库存调拨真正过户（扫码）|
| 17 | POST `/api/purchase/{po_id}/cancel` | purchase.py:521 | 可逆性弱：已收货后撤销 → 库存/账面失衡 |
| 18 | POST `/api/inventory/direct-inbound` | inventory.py:423 | 直接动数据：绕过 PO 直接入库（默认 423 冻结）|
| 19 | POST `/api/inventory/direct-outbound` | inventory.py:499 | 直接动数据：绕过订单直接出库 |
| 20 | POST `/api/payroll/salary-records/{id}/pay` | payroll.py:805 | 动账：工资发放扣品牌现金 |
| 21 | POST `/api/payroll/salary-records/batch-pay` | payroll.py:1862 | **批量动账**：批量发工资 |
| 22 | POST `/api/payroll/manufacturer-subsidies/confirm-arrival` | payroll.py:1072 | 动账：厂家补贴到账进品牌现金 |
| 23 | POST `/api/mall/admin/orders/{id}/confirm-payment` | mall/admin/orders.py:631 | 动账：mall 订单收款入 master 池 |
| 24 | PUT  `/api/customers/{id}/brand-salesman` | customers.py:186 | **关键审计**：改客户归属业务员，影响未来订单提成归属（boss 决策升 L2） |
| 25 | POST `/api/mall/admin/salesmen/{id}/rebind-employee` | mall/admin/salesmen.py:425 | **关键审计**：换绑后 commission 归属混乱风险（boss 决策升 L2） |
| 26 | POST `/api/inspections/inspection-cases/{id}/recover-to-stock` | inspections.py:798 | **跨模块**：案件回库逆向影响利润台账（boss 决策升 L2） |
| 27 | POST `/api/inspections/cleanup-cases/{id}/stock-in` | inspections.py:854 | 同上：清理案件入库逆向影响（boss 决策升 L2） |
| 28 | POST `/api/expense-claims/{id}/apply` | expense_claims.py:213 | 动账：F 类报销垫付扣品牌现金 + 录方案号（2026-05-21 升 L2） |
| 29 | POST `/api/expense-claims/{id}/confirm-arrival` | expense_claims.py:266 | 动账：厂家拨款到账加品牌 F 类账户（2026-05-21 升 L2） |
| 30 | POST `/api/expense-claims/{id}/fulfill` | expense_claims.py:317 | 跨模块时序：触发兑付返还动账（2026-05-21 升 L2） |
| 31 | POST `/api/expense-claims/{id}/pay` | expense_claims.py:339 | 动账：日常报销付款扣品牌现金 / master 现金（2026-05-21 升 L2） |
| 32 | PUT  `/api/auth/users/{user_id}` | auth.py:308 | **权限变更**：启停账号、改 employee 关联（2026-05-22 升 L2） |
| 33 | PUT  `/api/auth/users/{user_id}/roles` | auth.py:361 | **权限变更**：改用户角色（admin/boss/finance/...）→ 影响 RBAC + RLS 全局过滤（2026-05-22 升 L2） |
| 34 | POST `/api/auth/users/{user_id}/reset-password` | auth.py:341 | **关键审计**：重置密码会被审计日志追溯（2026-05-22 升 L2） |
| 35 | POST `/api/payroll/employees/{id}/brand-positions` | payroll.py:323 | **权限变更**：员工绑品牌×岗位 → 决定能看哪个品牌的数据 + 提成怎么算（2026-05-22 升 L2） |
| 36 | PUT  `/api/payroll/brand-positions/{id}` | payroll.py:362 | 同上（2026-05-22 升 L2） |
| 37 | DELETE `/api/payroll/brand-positions/{id}` | payroll.py:393 | 同上（2026-05-22 升 L2） |
| 38 | PUT  `/api/hr/employees/{id}/store-assignments` | hr.py:478 | **权限变更**：员工绑门店多对多 → 决定能看哪些门店仓 + 收银能看哪些库存（2026-05-22 新增 L2） |

---

## 留 L1 的边界场景（boss 已决策）

- `payroll/salary-records/generate` (payroll.py:1286) — 批量生成 draft 工资单，**不动账**，等 `/pay` 才进 L2
- `payroll/salary-records/batch-confirm` (payroll.py:2002) — draft → pending_approval 状态推进，**不动账**

---

## L1 中敏（约 60 条，需 audit + idempotency + 限额）

来源：业务状态推进、单条审批、可逆写入。AI 可调用但需 `X-Channel` 区分、
要求 idempotency key、批量类有 size 上限。

**订单流转**：orders.py:393 (建单)、463 (create-with-policy)、815 (confirm-delivery)、
845 (ship)、915 (complete)、936/959/997/1015/1057/1133 (政策审批系列)、
1220/1250 (upload-delivery/payment-voucher)、1527 (resubmit)

**采购/库存**：purchase.py:121 (建 PO)、395 (approve)、497 (reject)、
608 (receive)；transfers.py:120/161/182/203/226 (调拨建/提交/批/驳/撤)；
inventory.py:380 (stock-out)、229/266 (warehouses)、2556 (low-stock notify)；
mall_purchase_orders.py:151/254/277/304/332/359；
mall/workspace/purchase_receiving.py:454；
mall/admin/inventory.py:189/247/354；
mall/workspace/purchase_orders.py:336

**政策/稽查**：policies.py:248 (建申请)、572/614/659/787 (兑付材料/状态)、
1095 (match-arrival)、1383 (submit-voucher)、1503 (建 claim)；
inspections.py:284/359 (建/改稽查案)、686/727 (cleanup-case)

**财务/收款**：finance.py:225 (Receipt)、423 (Payment)、536 (Expense)、
603/620 (Expense approve/reject)、691/751/801 (manufacturer-settlement 建/改/preview)、
888 (import-excel)、1545 (payment-request 建)；
accounts.py:311 (transfer reject)、360 (建账户)；
mall/admin/payments.py:124 (reject)、195 (manual-record)

**HR/工资**：payroll.py:643/670 (salary-record CUD)、702/731/762 (submit/batch-submit/approve)、
1027 (generate-expected)、1133 (manual-mark-arrived)、1286 (generate)、
2002 (batch-confirm)、2476 (recompute)；
hr.py:336/380/394/404 (commission CRUD + settle)；
attendance.py:456/515 (leave 提交/审批)；
mall/workspace/leave.py:95；
expense_claims.py L1 子集 (POST 67 创建 / PUT 135 改 / POST 151 approve / POST 198 reject / POST 391 settle / DELETE 414)
   —— 注意：apply (213) / confirm-arrival (266) / fulfill (317) / pay (339) 已升 L2，见上方

**门店/退货**：store_returns.py:324/355/383/408；
mall/admin/returns.py:133/188/231；
mall/workspace/store_returns.py:59；
mall/workspace/store_sales.py:214；
store_sales.py:163

**其他**：sales_targets.py:275/470；
financing.py:180/260/385/442/530；
mall/admin/orders.py:334 (cancel)、608 (reassign)；
mall/admin/user_applications.py:108/158；
mall/admin/skip_alerts.py:162；
mall/admin/housekeeping.py 5 条；
mall/admin/users.py:278/314/353；
mall/admin/salesmen.py:215/314/546/637/678；
mall/admin/products.py:318 (上下架)；
mall/orders.py:55/123/154/176

---

## L0 低敏（约 218 条，AI 可直通）

主数据 CRUD（brand / product / customer / employee / supplier / warehouse /
category / notice / keyword / policy-template / position / salary-scheme /
kpi-rule / assessment-item / org-unit / store-product 的 POST / PUT / DELETE）
+ 凭证上传（uploads.py、mall/attachments.py、mall/public_uploads.py）
+ 个人设置（mall/salesman/profile.py 4 条、mall/addresses.py 4 条、
mall/cart.py 2 条、mall/collections.py 2 条）
+ 通知 mark-read
+ auth/login/refresh/logout
+ 品酒/破损登记（tasting.py 全套）
+ dashboard 快照重建
+ 商品状态等

---

## 落地约束（阶段 0 → 1 → 2）

- **阶段 0**：FastAPI route 装饰器加 tags `['l2']` 或 `['l1']`；L0 默认不加。AI Gateway / audit 读 tag 决定行为。
- **阶段 1**：L2 接入 AI Gateway 走 `/api/agent/execute` 的 operation 命名 + Capability token；L1 加 idempotency；L0 透传。
- **阶段 2**：L2 引入草稿态 + Temporal/状态机兜底（最高 5 条最不可逆流程）。

## 维护

新增端点时一律先评估风险等级再合并。tag 与本清单不一致 → 一致为准。
