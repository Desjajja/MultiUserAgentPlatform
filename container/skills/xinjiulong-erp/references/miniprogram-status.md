# 小程序端（miniprogram/）现状与 Agent 注意事项

> 废弃说明（2026-05-11）
>
> 本文件内容已明显落后于当前源码与后端挂载状态，尤其是“`/api/mall/*` 全部 404”这类判断已不再成立。
>
> 自即日起，本文件仅保留作历史记录，不再作为现行开发、联调或排障依据。
>
> 小程序现行状态请改看 `references/business-atoms-mall.md`；如需核对跨端副作用与全局 gap，再配合 `references/business-atoms-bridges.md`。

**作用**：历史记录。保留这份文档只是为了追溯过去某一阶段的小程序接通状态，不代表当前真实系统状态。

---

## 一、整体部署拓扑（三端同一后端）

monorepo 下三个独立部署子项目：

| 子项目 | 干嘛的 | 调什么接口 | 包管理 |
|---|---|---|---|
| `backend/` | 统一 FastAPI 后端 | — | pip（requirements.txt）|
| `frontend/` | React ERP 管理台 | `/api/*` | npm |
| `miniprogram/` | uni-app Vue 3（H5 / 微信小程序 / App） | `/api/mall/*` | pnpm |

**后端只有一份**：同一个 FastAPI 进程 + 同一个 Postgres + 同一套 JWT 工具。按路由前缀分流：
- `/api/*` → ERP 管理台专用（`backend/app/api/routes/xxx.py`）
- `/api/mall/*` → 小程序专用（`backend/app/api/routes/mall/xxx.py`）
- 共享 service 层（attendance / expense_claims / receipt_service 等）通过 `ActorContext` 承接两端调用

---

## 二、小程序承载的两种角色（同一套代码）

一个 uni-app 代码库，按登录用户的 `user_type` 分流页面：

### 2.1 C 端商城（customer）

**页面**（`miniprogram/src/pages/` 下非 salesman-* 开头的）：
- `index` 首页
- `category / sub-category / prod-classify` 品类 / 子品类 / 分类详情
- `prod` 商品详情
- `basket` 购物车
- `search-page / search-prod-show` 搜索
- `delivery-address / editAddress` 收货地址
- `submit-order / order-detail / orderList` 下单 / 订单详情 / 订单列表
- `pay-result` 支付结果
- `express-delivery` 物流
- `accountLogin / register` 登录 / 注册
- `user` 个人中心
- `news-detail / recent-news` 公告

**注册约束**：C 端注册**强制 invite_code**（只有业务员发的邀请码才能注册成客户），对应后端 `mall/admin/invite_codes.py` 管理。

### 2.2 业务员工作台（salesman）

**页面**（`miniprogram/src/pages/salesman-*`，共 19+ 个）：
- `salesman-workspace` 工作台首页（接单池）
- `salesman-home` 首页概览
- `salesman-orders / salesman-order-detail` 订单 / 详情
- `salesman-my-customers` 我的客户（**G16 手机脱敏，拨号时才调 reveal 端点**）
- `salesman-upload-voucher` 上传收款凭证
- `salesman-checkin` 打卡
- `salesman-attendance` 考勤记录
- `salesman-visit` 客户拜访
- `salesman-leave` 请假
- `salesman-expense` 报销
- `salesman-inspection` 稽查登记
- `salesman-kpi` KPI 查看
- `salesman-notifications` 通知
- `salesman-invite` 邀请码（发给客户用的）
- `salesman-alerts` 跳单告警
- `salesman-profile` 个人资料
- `salesman-commissions` 我的提成流水（**G6 决策 #1 透明化**：pending/settled/reversed/追回 四格 + Tab 过滤）
- `salesman-ship-scan` 扫码出库（mall 仓条码出库）

### 2.3 门店收银（店员专属，assigned_store_id 非空才可见）

**页面**（`miniprogram/src/pages/` 下 store-* 开头）：
- `store-cashier` 门店收银（**决策 #3 散客支持**：会员/散客两种模式 Toggle）
- `store-my-sales` 门店业绩（本月汇总 + 销售流水）

**入口**：`salesman-workspace` 页面的快捷入口，仅 `assigned_store_id` 非空的店员可见。

**核心概念**：业务员小程序工作台 ≠ ERP frontend。ERP frontend（React）是**管理台**给 boss / finance / HR / warehouse 用的。业务员在外面跑业务只带手机 → 只用小程序。

---

## 三、⚠️ 后端 mall 路由当前接通状态（重要）

**真实状态（2026-04-29 截止）**：

后端代码**文件都写好了**：
- `backend/app/api/routes/mall/` → auth / cart / products / categories / orders / addresses / regions / collections / notices / search / salesman/* / workspace/* / admin/*
- `backend/app/models/mall/` → user / product / order / inventory / content
- `backend/app/schemas/mall/` → 同样齐全
- `backend/app/services/mall/` → order_service / invite_service / commission_service / profit_service / actor_context / auth_service / attachment_service 等

**但 `backend/app/main.py` 里 mall 路由全部注释掉了**（TODO M3-M5）。意味着：

> **现在 miniprogram 调 `/api/mall/*` 任何接口都会返回 404**。

小程序前端已经在调用（见 `miniprogram/src/pages/*.vue`）：
- `/api/mall/salesman/orders/pool?scope=my|public`
- `/api/mall/salesman/orders/{order_no}/claim`
- `/api/mall/salesman/orders/{order_no}/upload-payment-voucher`
- `/api/mall/salesman/profile`
- `/api/mall/salesman/stats`
- `/api/mall/salesman/my-customers`
- `/api/mall/salesman/skip-alerts`
- `/api/mall/workspace/attendance/today`
- `/api/mall/workspace/notifications`
- `/api/mall/workspace/notifications/unread-count`
- `/api/mall/workspace/notifications/{id}/mark-read`
- `/api/mall/workspace/notifications/mark-all-read`
- `/api/mall/salesman/attachments/upload`

这些接口**文件都在、函数都写了、但没在 main.py 挂载**。小程序是"半成品 demo 状态"，能跑前端页面但调接口直接 404。

### Agent 应对方式

- **如果用户说"小程序登录不上 / 上传凭证失败 / 打卡报错"**：第一反应查是不是 mall 路由没挂，而不是猜业务 bug
- **不要主动推荐用户走小程序完成 ERP 端的操作**（比如不要说"你可以在小程序上传凭证"）——直到有明确同步说 mall 接口已挂载
- **当前小程序真的能用的**：只有**纯静态页**（商品展示 / 购物车本地状态 / 订单表单等），一旦跨 HTTP 就挂

---

## 四、小程序的身份认证（未来接通后）

mall 接口接通后，身份认证与 ERP 共用同一套 JWT 机制但有区别：

### 4.1 用户表不同

- ERP：`user` 表（员工 erp_user）
- 小程序 C 端：`mall_user` 表（客户 customer）
- 业务员：是 `user` 表（role='salesman'）也在小程序登录，但走 mall 登录接口

### 4.2 登录方式

- C 端商城用户 → `POST /api/mall/auth/login`（账号密码 / 短信验证码 / 微信授权）
- 业务员 → 也走 mall 登录，后端鉴别 role=salesman 发业务员专属 JWT
- 注册 → `POST /api/mall/auth/register` + 强制 `invite_code`

### 4.3 Agent 不走小程序路径

**Agent 永远走 ERP 路径**（`/api/feishu/exchange-token` → ERP JWT），不走 `mall/auth`。因为：
- Agent 是"企业智能体"代员工操作后端
- 员工在飞书跟 Agent 对话时，不需要小程序登录
- 所有业务员能在小程序做的事，Agent 都用 ERP 路径帮他做（ERP 跟 mall 后端都是同一个 Postgres，数据相通）

---

## 五、"共享 service 层" 的意思

后端 `app/services/` 下很多 service 两端共用（比如 `attendance_service / expense_claim_service / receipt_service`）。

调用方通过 `ActorContext` 区分是谁：
```python
ctx = ActorContext(
    user_id="...",
    role="salesman",
    brand_ids=[...],
    source="mall",  # or "erp"
)
await expense_claim_service.create(ctx, claim_data)
```

**对 Agent 的含义**：
- Agent 走 ERP 路径调接口，后端 service 层照样接住
- 数据（打卡记录 / 报销单 / 凭证）在 DB 里一份，不会因为"这条是小程序传的"就跟 ERP 隔离
- Agent 推的报销审批 / 打卡查询 → 和业务员在小程序上传的**是同一张表**

---

## 六、小程序相关的文件位置速查

### 前端（`miniprogram/`）

- `src/pages/*/` — uni-app 页面
- `src/utils/http.js` — HTTP 层（自动刷新 token / 注入 Authorization）
- `src/utils/salesman.js` — 业务员专用工具函数
- `src/pages.json` — 路由声明（uni-app 不是文件路由，必须登记）
- `src/manifest.json` — 平台配置（H5 domain / mp-weixin appid 等）
- `.env.development / .env.production` — `VITE_APP_BASE_API` 是后端地址

### 后端（`backend/app/`）

- `api/routes/mall/` — 所有 mall 路由文件（**当前未挂载**）
- `models/mall/` — mall 专属模型（mall_user / mall_order / mall_product / mall_inventory / mall_content）
- `schemas/mall/` — Pydantic schema
- `services/mall/` — mall 专属 service + 共享 actor_context
- `main.py` L137-L154 — 注释掉的 include_router（路标）

---

## 七、Agent 能对小程序做什么（当前阶段）

### 不能做

- ❌ 不能替用户完成任何小程序 HTTP 操作（接口都 404）
- ❌ 不能让用户"到小程序上传凭证"（目前走不通）
- ❌ 不能混淆 `/api/*` 和 `/api/mall/*`（后者目前全挂）

### 能做

- ✅ 告诉用户"小程序功能 M3-M5 milestone 还没上线，当前走 ERP 管理台 / 飞书"
- ✅ 用 ERP 路径帮业务员完成小程序原本要做的事（打卡、上传凭证、查业绩、请假、报销）
- ✅ 查看小程序代码里已有的接口契约（推断未来接通后的功能形态）

---

## 八、milestone 路标（来自 CHANGELOG + main.py 注释）

计划分 5 个 milestone 接通：
- **M1** ✅ 小程序前端骨架（17 个 salesman 页 + C 端商城页）
- **M2** ✅ 后端 mall_* 模型 / schema / service 文件落地（但路由未挂）
- **M3** 🟡 C 端商城路由挂载（auth / products / cart / orders）
- **M4** 🟡 业务员工作台路由挂载（salesman / workspace）
- **M5** 🟡 管理端路由挂载（admin）

**Agent 判断"现在是不是 M3 接通了"的方法**：用用户 JWT 调 `GET /api/mall/products` 之类，返回 200 就是接通了，返回 404 就还是 M1-M2。

---

## 九、对 Agent 的最终建议

小程序端**当前可视为"展示用的 demo"**：
- 能看 UI、不能完整跑通业务
- 接入 ERP 的能力主要还在 ERP 管理台 + 飞书卡片 + Agent 自身

**除非用户明确说"小程序 M3 / M4 milestone 已接通"，否则 Agent 默认走 ERP `/api/*` 路径**，不要把 `/api/mall/*` 当成可用接口去推荐。
