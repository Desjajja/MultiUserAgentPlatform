# 库存与采购

## 库存双轨制

- **数量账**（`inventory` 表）：按 product × warehouse × batch_no 聚合，记瓶数。**自 m6cy 起受 RLS**：门店仓（`warehouse_type='store'`）走 `w.id ∈ app_current_store_ids()` —— 业务员要在 `employee_store_assignments` 里绑了这家门店才能看；非门店仓（main/backup/tasting）走 `w.brand_id ∈ app_current_brand_ids()` —— 业务员的 brand_ids 命中才能看。两套权限独立。admin 看全部
- **条码追溯**（`inventory_barcodes` 表）：每瓶酒一条，附带追溯历史
- **全局主账**（`barcode_registry` 表）：每个厂家防伪码全公司唯一一行（registry first 互斥），跨域 / 跨仓重复入库会 409 拒绝
- **追溯事件**（`barcode_events` 表）：每条码的完整历史（PURCHASE_RECEIVE / TRANSFER / SALES_SHIP / INSPECTION_INFLOW 等）

**白酒铁律**：白酒每瓶都有厂家防伪码。**采购收货 / 业务员出库 / 仓库调拨 / 门店零售出库** 全部必须扫码过户，**绝不允许按数量散装**。后端 `inventory_service.py` + `inventory.py:387-391` 在销售出库强校验 barcode 必填，传空数组直接 400。

## 仓库类型（warehouse_type）

代码事实（inventory.py:214）：`main / backup / tasting / store`，外加 mall 侧的 `mall_warehouse / mall_goods`。**不存在** `retail / wholesale` 这两种类型（历史误标，已废止）。

| type | 归属 | 含义 | 业务约束 |
|---|---|---|---|
| `main` | ERP 独立品牌 | 主仓 — 正常销售出库 | **铁律**：出入都禁；只能通过采购单入 + 销售订单出，不允许调拨 / direct-inbound / direct-outbound |
| `backup` | ERP 独立品牌 | 备用仓 — 周转、借货 | 允许 direct-inbound + direct-outbound + 调拨 |
| `tasting` | ERP 独立品牌 | 品鉴仓 — 政策物料、试饮 | 政策 fulfill-materials 走这里出；允许 direct-outbound + 调拨 |
| `store` | ERP 门店仓（warehouse_id 挂 4 家专卖店） | 门店零售出货 | 店员扫码出库（B12 桥）；建仓时自动建 `mall_user.assigned_store_id` 关系 |
| `mall_warehouse` | mall 仓 | 商城前置仓 | 仓管通过 miniprogram 扫码出库；调拨补货 / 自采 / admin 直入三入口 |
| `mall_goods` | mall 在售商品聚合视图 | 不存实物 | 仅查询用 |

## 三类入仓口径（CLAUDE.md 写死，Agent 必读）

判断"该走哪个入仓入口"先看仓库归属：

### 类 ① 独立品牌（ERP main / backup / tasting）

**只认正式采购入仓**——不允许任何直接绑码/直接入库。
- 总部 ERP `/api/purchase-orders` 建 PO，`scope='liquor'` + `target_warehouse_type='erp_warehouse'` + `warehouse_id=<目标主仓/backup/tasting>`
- boss/finance 审批 → `_do_receive_purchase_order` 扫码收货
- ~~`/api/inventory/stock-ins/bind-barcodes`~~ 和 ~~`/api/inventory/barcodes/batch-import`~~ **已于 Phase B 彻底删除**（不再存在路由）。所有入库必须经 `POST /api/purchase-orders/{po_id}/receive` —— 该端点同事务写 `inventory_barcodes` + `barcode_registry` + `barcode_events` 三张表，无两阶段窗口。

**钱的动向**：白酒采购的账户扣款发生在**审批**那一步（`purchase.approve` 扣品牌 cash / f_class / financing 按 PO 字段配比），**不是**收货时。收货只动库存（barcode 三表）+ payment_to_mfr 应付台账，不动现金。

### 类 ①.5 品鉴仓采购的特例（**Agent 必须注意**）

品鉴仓 (`warehouse_type='tasting'`) 走同一条 `/api/purchase-orders` 路径，但**收货端硬编码绕开了"必须 PAID 才能收货"的校验**（purchase.py:650-654）：

```python
is_tasting = (not is_mall) and wh and wh.warehouse_type == 'tasting'
if not is_tasting and po.status not in (PAID, SHIPPED):
    raise 400 "采购单状态为 'X'，需要先审批付款才能收货"
```

意思：**品鉴仓的 PO 可以"先收货后付款"**，不强制按 main / backup 那样必须先 boss/finance 审批扣款。这是历史上厂家给经销商赠送品鉴酒物料、合同后补的业务实操让步。

**Agent 行为**：
- 建品鉴酒 PO 时跟普通 liquor PO 一样 → `scope='liquor'`, `warehouse_id=<品牌的 tasting 仓>`
- 收货前 **不要**自动调 `purchase.approve` —— 品鉴仓 PO 直接调 `/receive` 即可
- **不要逐项追问** "数量？/ 仓库？/ 单价？/ 付款方式？" —— 品鉴酒采购默认 0 元 + 自动锁定该品牌 tasting 仓 + 厂家赠送，**只追问数量**即可
- 其他 main/backup 仓 PO 仍然按"先 approve 再 receive"标准流程

**Agent 完整对话模板见 `agent-playbook.md` 场景 21.1**（建品鉴酒采购单的丝滑模板）。

### 类 ② 门店（warehouse_type='store'，4 家专卖店）

两条合法来源：

**A. 总部代下单**：ERP `/api/purchase-orders` 建 PO，`scope='store'` + `target_warehouse_type='erp_warehouse'` + `warehouse_id=<门店仓>` → 店员在 miniprogram `/api/mall/workspace/purchase-receiving` 扫码收货

**B. 门店店长自采**：店长（`mall_user.assigned_store_id IS NOT NULL`）在 miniprogram `/api/mall/workspace/purchase-orders` 建单 → 后端自动填 `scope='store'` + `target_warehouse_type='erp_warehouse'` + `warehouse_id=自己门店` → boss/finance ERP 审批 → 店员扫码收货

### 类 ③ 商城仓（mall_warehouses）

三条合法来源，日常按工作量取舍：

**A. 调拨补货**（推荐，已有 ERP 库存的商品）：`transfer_service` 从 ERP 非主仓 / 其他 mall 仓调入

**B. mall 仓管自采**（仓管 = `mall_user.assigned_store_id IS NULL` 且被某 `mall_warehouse.manager_user_id` 指向）：miniprogram `/api/mall/workspace/purchase-orders` 建单 → `scope='mall'` + `target_warehouse_type='mall_warehouse'` + `mall_warehouse_id=自己管的仓` → boss/finance 审批 → 仓管在 miniprogram 扫码收货

**C. admin 直接入库**（`/api/mall/admin/inventory/inbound` 和 `/barcodes/import`）：定位**灰度/应急**，不作日常业务推广

## Agent 场景 1：查库存

```
GET /api/inventory/batches?brand_id=X&product_id=Y&warehouse_id=Z
```

Agent 展示：`青花郎53度500ml — 主仓库 120 瓶`。

### 低库存预警

```
GET /api/inventory/low-stock?threshold=5    // 小于 5 箱（默认）
```

返回低于阈值的 SKU。Agent 主动告诉相关品牌的 warehouse / boss。

### 条码追溯

```
GET /api/inventory/barcode-trace/{barcode}
```

返回一瓶酒从入库到当前位置的完整历史（采购入库 → 政策出库 → 客户 → 稽查回收 → ...）。用户扫码后 Agent 展示历史链。

## Agent 场景 2：手工直接出入库（受限）

**direct-inbound**（inventory.py:435-436）：仅允许 `warehouse_type in ('main', 'backup')` 中的 backup —— **main 主仓被铁律挡住**，只能采购入。

**direct-outbound**（inventory.py:510-511）：仅 `tasting / backup / retail / wholesale`（注意代码这行注释还保留 retail/wholesale，但实际仓库表没这两种 type；新建仓不会有，旧数据可能有）

```
POST /api/inventory/direct-outbound
{
  "product_id": "...",
  "warehouse_id": "<backup 或 tasting>",
  "quantity": 1,
  "quantity_unit": "瓶",
  "notes": "破损"
}
```

Agent 在让用户操作之前**强烈提醒**："直接出入库不走正常业务流，会影响利润台账，请确认有授权"。只对 warehouse/boss 开放。

## Agent 场景 3：出入库流水

```
GET /api/inventory/stock-flow?type=policy_out&warehouse_id=X&date_from=...
```

`type`（StockFlow 类别）：
- `purchase_in` 采购入库
- `order_out` 订单出库
- `policy_out` 政策物料出库
- `return_in` 退货入库
- `transfer_in/out` 转仓
- `direct_in/out` 手工调整
- `inspection_in/out` 稽查回收/出库
- `tasting_out` 品鉴酒消耗

## 采购单流程（PurchaseOrder）

```
建单 (pending) 
  → boss/finance 审批 (approved)  
  → 扣账户（cash_amount + f_class_amount + financing_amount）
  → paid
  → 仓库收货（/receive 扫码或店员/仓管 miniprogram 收货）
  → received
  → 写 payment_to_mfr += cash + financing（代记应付已结）
```

**scope 维度**（purchase.py:131-162 强校验）：
- `scope='liquor'`：白酒采购，必须 `brand_id`；`target_warehouse_type='erp_warehouse'`；`warehouse_id` 必须在该品牌名下的 main/backup/tasting 中
- `scope='store'`：门店采购，必须 `target_warehouse_type='erp_warehouse'` + `warehouse_id=门店仓`
- `scope='mall'`：商城采购，必须 `target_warehouse_type='mall_warehouse'` + `mall_warehouse_id`

## Agent 场景 4：建采购单

```
POST /api/purchase-orders
{
  "po_no": "自动生成",
  "scope": "liquor",                          // 必填
  "brand_id": "...",                          // liquor 必填，mall/store 可空
  "supplier_id": "<厂家 supplier id>",
  "target_warehouse_type": "erp_warehouse",   // 或 mall_warehouse
  "warehouse_id": "<ERP 仓>",                 // erp_warehouse 必填
  "mall_warehouse_id": null,                  // mall_warehouse 必填
  "cash_amount": 50000,
  "f_class_amount": 0,
  "financing_amount": 0,
  "cash_account_id": "...",
  "items": [
    { "product_id": "...", "quantity": 100, "unit_cost": 500 }
  ]
}
```

**关键**：`cash_amount + f_class_amount + financing_amount` 要和 `SUM(items.quantity * unit_cost)` 对得上（浮点容错 0.01）。

Agent 收集参数后**卡片展示完整摘要**，用户确认再调。

## Agent 场景 5：采购审批

```
POST /api/purchase-orders/{id}/approve
```

boss/finance 调。后端：
- cash_account.balance -= cash_amount + 写 fund_flow
- f_class_account.balance -= f_class_amount + 写 fund_flow
- financing_account.balance -= financing_amount + 写 fund_flow
- status → `paid`
- payment_to_mfr 账户 += cash_amount + financing_amount（代表"已付给厂家"）

如果某账户余额不足 → 400，告诉用户"XXX 账户余额不足 ¥YYY"。

## Agent 场景 6：采购撤销

```
POST /api/purchase-orders/{id}/cancel
```

后端用 `SELECT FOR UPDATE` 锁 `payment_to_mfr` 账户 + 校验余额足够。余额不足时 400（用户确认已结算过部分 → 需联系财务）。

Agent 告诉用户："撤销采购会退钱到原账户。如果期间有其他操作导致余额不足，系统会拦截。"

## Agent 场景 7：收货（按 scope 分流）

### A. ERP 仓收货（main/backup/tasting/store）

总部仓 + 门店仓都走这条：

```
POST /api/purchase-orders/{po_id}/receive
{
  "received_items": [
    { "po_item_id": "...", "actual_quantity": 100, "batch_no": "...", "barcodes": ["..."] }
  ]
}
```

warehouse 角色（总部仓）或店员（门店仓店员）调用，需扫码补全 barcodes。后端：
- 增库存（StockFlow 类型=`purchase_in`）
- 批量导入 `inventory_barcodes` + `barcode_registry` + `barcode_events`
- PO.status → `received`

### B. 门店店员小程序收货

```
POST /api/mall/workspace/purchase-receiving
```

scope=store 的 PO，店员在 miniprogram 扫码完成；后端落地等同 A。

### C. mall 仓管小程序收货

scope=mall 的 PO，仓管在 miniprogram 扫码完成；落地 mall 仓 inventory。

## ~~Agent 场景 8：bind-barcodes / batch-import~~（已废止）

**Phase B（2026-05-19）彻底删除这两个端点**：

```
POST /api/inventory/stock-ins/{flow_id}/bind-barcodes   ✗ 已删除
POST /api/inventory/barcodes/batch-import               ✗ 已删除
```

### 为什么删

历史上这两个接口**只写 `inventory_barcodes` 表**，不写 `barcode_registry` / `barcode_events`，构成"两阶段窗口"漏洞：
- 同一条码可以在两个仓里同时存在（registry 不拦）
- 销售出库时反查 registry 找不到来源，追溯链断
- warehouse 角色可绕过采购流裸写库存

Phase B 把 `POST /api/purchase-orders/{po_id}/receive` 改成**统一对所有 ERP 仓（main/backup/tasting/store）+ mall 仓**都同事务写三张表（registry + events + 老表），不再有两阶段窗口；这两个裸接口就没有存在的必要了。

### 真要补码怎么办

历史用 admin_override 补 mock 数据的场景：开发期手工灌 SQL，**走 `barcode_registry` + `barcode_events` 一并写**（参考 `scripts/e2e_barcode_registry.py` 中 `record_inbound` 用法）。不要再造"裸写表"接口。

Agent 提示用户："正常入仓必须走 `POST /api/purchase-orders/{po_id}/receive` 扫码收货。`bind-barcodes` / `batch-import` 已在 Phase B 删除，不再支持。"

## 常见错误

| detail | 解释 |
|---|---|
| "库存不足" | 出库数 > 库存，检查 warehouse/product/batch |
| "回款账户 XXX 余额不足 ¥YYY，无法撤销" | 采购撤销余额校验（Bug #4 修复） |
| "采购单状态为 'X'，只有 paid（已付款未收货）可撤销" | 已收货的走退货流程 |
| "直接入库仅限主仓和备用仓" | direct-inbound 给了 tasting 或 store |
| "直接出库仅限品鉴酒仓、备用仓、零售仓和批发仓" | direct-outbound 给了 main 或 store |
| "白酒采购（scope=liquor）必须指定 brand_id" | 建 PO 漏了 brand_id |
| "门店采购（scope=store）必须指定门店仓（warehouse_id）" | scope=store 没传 warehouse_id |
| "商城采购（scope=mall）必须指定 mall 仓" | scope=mall 没传 mall_warehouse_id |
| "ERP 仓收货必须提交厂家防伪码列表（barcodes_by_item）" | Phase B 后 ERP 主仓 / backup / tasting 收货也强制扫码 |
| 409 "已存在于全局追溯主账" | 跨仓重复同一条码（registry first 互斥拦截） |
| ~~423 "条码绑定 / 批量入码已冻结"~~ | Phase B 后这两个接口已删除，永远见不到此错误了 |
| 404 "PurchaseOrder not found" | RLS 挡 / id 错 |
