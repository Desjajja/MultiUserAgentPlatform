---
name: experiment_archive
description: 实验总结与数据归档。当用户说"实验结束"、"归档"、"保存实验"、"总结实验"、"归档数据"、"数据存档"、"存档"时触发。
metadata:
  emoji: "📂"
---

# FrontLane LabOps · 实验报告与归档规范 (v2.1)

## 归档策略（三处存储，每次"数据存档"任务必须分发完整三处）

每次执行"数据存档"任务时，按下表三处分发，**禁止只做其中一两处**。

| # | 存储类型 | 后端 / 路径 | 内容 | 用途 |
|---|---|---|---|---|
| 1 | **lab_db SQL 数据库** | POST `http://localhost:7001/api/experiments/ingest`（upsert：写已有 exp_id 时更新 status: planned → finished） | exp_id / created_at / title / route / params / status / operator / notes（experiment_card 的 8 字段，status 改为 `finished`） | "查昨天做了什么"类结构化查询 |
| 2 | **本地 raw 文件目录** | `/workspace/agent/archives/{exp_id}/raw/` | Chromeleon 导出的 csv、原始图片、动作日志等原始数据文件 | 查阅完整原始记录 |
| 3 | **RAG 知识库 + 本地 summary** | POST `http://localhost:7001/api/knowledge/upload`（RAG）<br>同时落盘 `/workspace/agent/archives/{exp_id}/summary.md`（本地副本） | LLM 生成的实验总结 markdown | "找类似实验"语义搜索 |

## 归档工作流（3 步，必须全部执行）

### 步骤 1：lab_db 更新状态
通过 lab_db skill 的 `ingest` 子命令把 8 字段（status 改为 `finished`）写回数据库（upsert 语义，已有记录则更新）：

```bash
python3 <lab_db_bridge_path> ingest --exp-id <exp_id> --data '<8字段 JSON, status="finished">'
```

- exp_id 必须存在于会话上下文（来自之前 experiment_card 步骤）
- 找不到 exp_id → 失败，追问用户："请先生成实验卡片再归档（实验卡片包含 exp_id）。"

### 步骤 2：拷贝原始数据到 archives/{exp_id}/raw/
```bash
mkdir -p /workspace/agent/archives/<exp_id>/raw/
cp <原始文件1> <原始文件2> ... /workspace/agent/archives/<exp_id>/raw/
```

- 原始文件清单：用户消息显式提供 → 直接用；未提供 → 主动询问"需要归档哪些原始文件？路径列出来。"，禁止自行扫目录瞎猜
- 任一文件拷贝失败 → 记 error 继续步骤 3（最终 status=partial）

### 步骤 3：LLM 生成 summary.md，双写 RAG + 磁盘
LLM 根据 lab_db 8 字段 + 本次会话上下文（哪步成功 / 失败 / 异常 / 耗时）生成实验总结 markdown：

- summary.md 必含板块：
  - 实验标题（来自 title）
  - 操作者（来自 operator）
  - 时间（created_at + 当前时间作为 finished_at）
  - 最终 status
  - 关键参数（来自 params）
  - 过程亮点 / 异常
  - 改进建议
- **双写**：
  - 落盘：`/workspace/agent/archives/<exp_id>/summary.md`
  - 上传 RAG：POST `http://localhost:7001/api/knowledge/upload`（请求 body 格式以 rag-upload 或 lab_db 相关 SKILL.md 为准）

任一双写失败 → 记 error，状态降为 partial，**但不中止流程**（已完成的部分要保留）

## Result Contract

- `contract_version`: `v2`
- `kind`: `artifacts`
- `status=ok`：三处存储全部成功（lab_db ingest + raw 文件拷贝 + summary 双写 RAG/磁盘）
- `status=partial`：任一处失败但其余成功（产物部分生成，需用户决定是否补齐）
- `status=failed`：步骤 1 找不到 exp_id（无法启动归档），或全部三处都失败
- `required_outputs`：`text`（归档完成报告，列出三处存储的成功 / 失败明细）
- `optional_outputs`：`file`（summary.md 本地路径）
- `execution_failure_examples`：lab_db 离线、archives/ 目录不可写、RAG API 离线、原始文件清单缺失
- `delivery_hints`：`text` 是主交付物，必须列三处存储的明细，让用户能立刻看到哪里漏了。
