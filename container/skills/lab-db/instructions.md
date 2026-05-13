---
name: lab_db
description: 实验数据库操作。触发条件：用户说"写入实验"、"搜索实验"、"查询报告"、"查数据"、"历史数据"、"查实验结果"、"结果不对"。
metadata:
  openclaw:
    emoji: "🗄️"
---

# 实验数据库操作规范

本地 API 运行在 `http://localhost:7001`，直接用 `exec` 调用 bridge.py。

## 使用方法

### 写入实验数据
```bash
python3 {baseDir}/bridge.py ingest --exp-id EXP_001 --data '{"ph": 10.5, "temperature": 90}'
```

### 搜索实验
```bash
python3 {baseDir}/bridge.py search --query "CO2 提锂"
```

### 获取实验报告
```bash
python3 {baseDir}/bridge.py report --exp-id EXP_001
```

## API 端点

| 操作 | 方法 | 端点 |
|------|------|------|
| 写入实验 | POST | `/api/experiments/ingest` |
| 搜索实验 | POST | `/api/experiments/search` |
| 获取报告 | GET | `/api/experiments/{experiment_id}/report` |
