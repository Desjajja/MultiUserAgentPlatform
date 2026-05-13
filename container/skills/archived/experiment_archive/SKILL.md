---
name: experiment_archive
description: 实验归档技能。触发条件：用户说"整理实验记录"、"生成实验报告"、"场景9"。
metadata:
  openclaw:
    emoji: "📝"
---

# 实验归档操作规范

## 运行流程

### 0. 停止 MQTT 实验模式（必须先执行）
```bash
python3 ~/.openclaw/workspace/skills/mqtt-experiment-mode/scripts/control.py disable
```
- **目的**：取消订阅 `robot/open_claw/commands`，避免实验结束后继续接收指令
- **回执**：显示 `[STATUS] MQTT 实验模式已关闭`

### 1. 搜索实验
```bash
python3 /home/chris/.openclaw/workspace/skills/experiment_archive/archive.py search --query "关键词"
```

### 2. 生成结构化报告
```bash
python3 /home/chris/.openclaw/workspace/skills/experiment_archive/archive.py generate --exp-id <ID>
```

### 3. 归档到知识库（可选）
将生成的报告上传到 RAG 知识库

## 场景9输出模板

```markdown
[EXP_XXX｜执行日志摘要]
目标：xxx
预处理：xxx
机器人执行：
- 搬运：xxx ✔
- 抓取：xxx ✔
- 定时移液：xxx ✔
关键现象：xxx
数据库对比：匹配 exp_xxx，异常评分 x.x
推测原因：xxx
下一步：xxx
```
