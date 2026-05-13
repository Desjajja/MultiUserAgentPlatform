---
name: experiment_card
description: 专门用于生成和锁定【实验卡片】。当用户确认执行计划（如说"确认计划"、"生成卡片"、"实验卡片"、"建卡"、"我选路线"、"生成 SOP"）时触发。
metadata:
  openclaw:
    emoji: "🗃️"
---

# 小环·实验卡片生成规范 (v2.0)

## 实验卡片字段规范（8 字段，缺任一视为生成失败）

LLM 生成实验卡片时必须填齐以下 8 个字段。任一字段缺失 → 不写入数据库，主动追问用户补全，禁止猜测填充。

| 字段 | 类型 | 规则 |
|---|---|---|
| `exp_id` | string | 格式 `EXP-{YYYYMMDD}-{seq}`，seq 是当天序号（001/002/003...）。生成时调用 lab_db 查询当天已有最大 seq 后 +1。 |
| `created_at` | string | ISO 8601 格式，精确到分钟，例：`2026-04-25T11:42+08:00`。 |
| `title` | string | 实验标题，从用户指令提取，不得自创。例：用户说"提锂实验路线 1" → title = "提锂实验（路线 1）"。 |
| `route` | string | 选用的路线编号 + 简称。例：`路线 1：碳酸盐沉淀法`。 |
| `params` | object (JSON) | 关键参数 JSON 字典，键值根据路线动态。例：`{"pH": 8.5, "温度": 90, "Li浓度": "5g/L"}`。 |
| `status` | enum | 取值之一：`planned` / `running` / `finished` / `failed`。卡片刚生成时填 `planned`。 |
| `operator` | string | 操作员姓名。默认 `徐泽军`，用户消息显式指定（如"今天小张做"）则覆盖。 |
| `notes` | string | 备注。默认空字符串 `""`。 |

## LLM 生成工作流（3 步，禁止跳步）

### 步骤 1：生成 8 字段
LLM 根据用户输入 + 上下文（实验路线信息、operator 信息）生成上述 8 字段。

- 字段不全（含猜测填充）→ 不进步骤 2，主动追问用户："还差 X / Y / Z 字段，请补充。"
- 8 字段齐全 → 进步骤 2

### 步骤 2：写入 lab_db 数据库
调用 lab_db skill 的 `ingest` 子命令把字段写入数据库（命令格式以 lab_db SKILL.md 为准）：

```bash
python3 <lab_db_bridge_path> ingest --exp-id <exp_id> --data '<8字段 JSON>'
```

后端：`http://localhost:7001/api/experiments/ingest`

- 写入成功（HTTP 200）→ 进步骤 3
- 写入失败 → **不进步骤 3**，向用户报告失败原因 + 不重试（让用户决定是否手动重试或修字段）

### 步骤 3：返回卡片 + SOP 给用户
将 8 字段卡片以 markdown 表格 + JSON 代码块两种形式呈现，附 SOP 步骤表格（格式见下节）。

## SOP 格式规范

每条 SOP 包含 N 步，每步必填 3 列：

| 序号 | 操作步骤 | 耗时估算 | 注意事项 |
|---|---|---|---|
| 1 | <动作描述> | <如：5 分钟> | <如：温度需稳定在 ±1℃> |
| 2 | ... | ... | ... |
| ... | ... | ... | ... |

- 步骤编号：1, 2, 3...（不许跳号）
- 耗时估算：每步必填，单位"分钟"或"小时"
- 注意事项：每步必填，无注意事项时填"无"

SOP 末尾附**总耗时**（所有步骤耗时之和）。

## Result Contract

- `contract_version`: `v2`
- `kind`: `artifacts`
- `status=ok`：8 字段齐全 + lab_db 写入成功 + 返回卡片 + SOP
- `status=partial`：8 字段齐全 + 卡片返回，但 lab_db 写入失败（产物已生成，存档未完成）
- `status=failed`：8 字段不全（步骤 1 失败），无产物
- `required_outputs`：`text`（卡片 + SOP markdown）
- `optional_outputs`：`file`（如附 SOP 单独文件）
- `execution_failure_examples`：字段缺失、lab_db 写入失败、bridge.py 调用异常
- `delivery_hints`：`text` 是主交付物，含完整卡片 + SOP；写入失败由 main 转告用户。
