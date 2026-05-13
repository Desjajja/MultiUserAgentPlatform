---
name: remote-liquid-exec
description: Execute remote pipetting (移液/取样/吸液/排液/换枪头) on the dobot host via the detect_move_vision_realtime HTTP API at http://192.168.66.154:8008. Submit tasks, poll until terminal, and report 移液完成/移液失败 to the user. Grasping (抓取/夹取/放置/离心管 → realman_grasp) is currently NOT mapped to a backend on this skill — flag to user if asked.
---

# Remote Liquid Exec

封装机械臂控制机上的 `detect_move_vision_realtime_api.py`（基于 `detect_move_vision_realtime.py` 的实时视觉移液流程）。

- Base URL: `http://192.168.66.154:8008`
- 资源独占：同一时刻只能有一个移液任务在跑
- 终态：`success` / `failed` / `stopped`

## 触发关键词

| 触发词 | 路由 | 状态 |
|---|---|---|
| 移液 / 取样 / 吸液 / 加样 / 分装 / 排液 / 排空 / 转移液体 / 换枪头 | `start` 子命令（detect_move_vision_realtime） | ✅ 当前可用 |
| 抓取 / 夹取 / 放下 / 放置 / 离心管 | realman_grasp | ⚠️ 暂无对应后端，遇到时直说"该流程当前未接入"，不要伪装执行 |

## 执行流程（条件门槛）

**铁律**：触发词（移液 / 取样 / 吸液 / 加样 / 分装 / 排液 / 排空 / 转移液体 / 换枪头）**+ 用户没有写任何非默认参数 → 路径 A 直跑，禁止再问参数表**。只有用户明确给了非默认参数才走路径 B 的拆解-确认流程。

### 路径 A — 默认 SOP 直跑（最常见，**默认走这条**）

适用情形（满足任一）：
- 用户只说"做一下取样" / "取样" / "做个移液" / "执行移液" / "帮我移液" / "按默认 SOP 取样"
- 用户没有提到：取样体积（μL）、试管数、目标容器、偏移参数

**立刻执行**（不要再问参数表，不要再等确认）：

```
python3 /Users/realityloop/.openclaw/workspace-exec-robot/skills/remote-liquid-exec/scripts/remote_liquid_exec.py start --task-count 4
```

> ⚠️ **路径铁律（exec preflight 强约束）**：
> - **必须**用上面这个 **绝对路径**调脚本。`{baseDir}` 不会自动展开成你期望的目录。
> - **严禁** `cd <dir> && python3 ...` —— OpenClaw exec preflight 拒所有 shell-compound（`&&` / `;` / `|` / `$(…)` / 重定向 / env 前缀），违反会直接报 `exec preflight: complex interpreter invocation detected`。
> - 脚本实际位置：`/Users/realityloop/.openclaw/workspace-exec-robot/skills/remote-liquid-exec/scripts/remote_liquid_exec.py`（exec-robot 上下文）。

参数全部用默认值：`task_count=4`，`skip_home_before_vision=true`，`no_show=true`。

提交**后**立刻把"步骤展示"表（见下文）发给用户让其知情；但**不需要**等用户确认就提交。

### 路径 B — 用户给了非默认参数（例外路径）

只在用户**明确**写了以下任一项时才走拆解-确认：
- 取样体积（"200μL" / "取 100 微升"）
- 非默认容器（指定了某根试管编号、特殊烧杯位置）
- 偏移参数（pipette_x_offset_mm / pipette_y_offset_mm / pipette_plan_association_mm 等）
- 自定义 task_count（"做 6 管" / "task-count 6"）

#### B1. 拆解原子动作

| 序号 | 动作 | 目标位置 | 参数 |
|---|---|---|---|
| 1 | 安装枪头 | 枪头架 A1 | — |
| 2 | 移动到 beaker | 烧杯 | — |
| 3 | 吸液 | 烧杯 | <用户给的μL> |
| 4 | 分液到试管 #N | 试管架 | task_count=N |
| 5 | 复位 | 观察位 | — |

每条只做一件事；剩余空缺参数不明确则问用户，**不猜**。

#### B2. 输出表后问 "以上 N 步是否确认执行？" — 用户确认前不得提交。

#### B3. 用户确认后执行

```
python3 {baseDir}/scripts/remote_liquid_exec.py start --task-count <N> --params-json {"pipette_x_offset_mm":-25,"pipette_y_offset_mm":-10,"pipette_plan_association_mm":170}
```

> JSON 作为单个参数原样传给 `--params-json`，**不要**在 exec 里加 shell 引号 —— openclaw exec 预检拒绝 shell quoting。把 JSON 串放进 args 列表的一个元素即可。

## 调用接口（subcommand）

| 子命令 | 用途 | 备注 |
|---|---|---|
| `health` | `GET /health` | 提交前先打一次 |
| `start` | `POST /api/pipette/start` + 轮询直到终态 | 默认 `skip_home_before_vision=true` `no_show=true` `task_count=4` |
| `status [--task-id TID]` | 查当前 / 指定任务状态 | 不带 task-id 查最近 |
| `stop` | `POST /api/pipette/stop` | 终止当前任务 |

### 完整示例

```
python3 {baseDir}/scripts/remote_liquid_exec.py health
python3 {baseDir}/scripts/remote_liquid_exec.py start --task-count 4
python3 {baseDir}/scripts/remote_liquid_exec.py status
python3 {baseDir}/scripts/remote_liquid_exec.py stop
```

## 终态判定 + 结束提醒（必做）

`start` 子命令会持续轮询 `/api/pipette/status`，每个状态点输出一行 JSON，**终态时输出**：
```json
{"final": "移液完成"|"移液失败"|"任务已停止", "task_id": "...", "status": "...", "result_message": "..."}
```

看到 `final` 字段后，**必须**立即 `message(action=send, content=...)` 把结果发给用户，格式：

- 成功：`✅ 移液完成（task_id=xxx）`
- 失败：`❌ 移液失败（task_id=xxx）原因：<result_message 摘要>`
- 停止：`⏹️ 任务已停止（task_id=xxx）`

失败时还需追加 `status --task-id xxx` 拉取日志尾部并摘要给用户。

把 `task_id` 写入今日 daily note（`memory/YYYY-MM-DD.md`），供后续"查任务状态"复用。

## 步骤展示（提交后立即输出）

提交后不等 API 返回就先发这张表给用户，让用户知道流程：

| 序号 | 步骤 | 位置 | 说明 |
|---|---|---|---|
| 1 | 安装枪头 | 枪头架 | 准备耗材 |
| 2 | 样品吸取 | 烧杯 | 吸取目标量 |
| 3 | 循环分液 | 各试管 | 按 `task_count` 依次分注 |
| 4 | 末端留样 | 离心管 | 剩余样品留存（如需） |
| 5 | 复位 | 观察位 | 机械臂回观察位 |

随后实时把每个 status JSON 转发关键字段（`phase` / `target_index` / `result_message`）。

## When to use

- "帮我执行移液 4 根试管" / "做一下取样" / "从烧杯排空到试管"
- "换枪头后继续移液"
- "查一下当前移液任务状态" → `status`
- "停掉当前移液" → `stop`

## When NOT to use

- 抓取 / 离心管放置 → 该流程当前未接入后端，告诉用户而不是伪装执行
- 直接连 `29999`：禁止；走本 HTTP API

## Output format

1. Step 表格（提交时立即输出）
2. 每轮 status 行（task_id / status / phase / target_index / message）
3. 终态 `final` 行 + 给用户的 message.send（✅/❌/⏹️ 一句话）
4. 失败时附 result_message 摘要

## Usage rules

- 触发词判定 pipeline，不猜
- 提交前必须 Step 1/2/3 走完
- 终态必须 message.send 提醒用户（哪怕是失败/停止）
- Bearer token 从 `OPENCLAW_API_TOKEN` 读取
- 机械臂控制口 `29999` 严禁直连
