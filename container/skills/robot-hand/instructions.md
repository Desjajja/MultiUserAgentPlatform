---
name: robot-hand
description: 控制灵巧手。通过MQTT发送指令控制灵巧手的抓取和手势动作。触发条件：用户提到灵巧手、hand、抓取、烧杯、试管、OK手势等
---

# 灵巧手控制

通过MQTT远程控制灵巧手。

## MQTT配置

- 服务器: `192.168.1.103:1883`
- 主题: `hand`

## 控制方式

```bash
bash scripts/control.sh <command>
```

### 命令

| 命令 | 功能 |
|------|------|
| `beaker_setout` | 准备抓取烧杯 |
| `beaker_grab` | 抓取烧杯 |
| `beaker_release` | 释放烧杯 |
| `tube_setout` | 准备抓取试管 |
| `tube_grab` | 抓取试管 |
| `tube_release` | 释放试管 |
| `reset` | 复位 |
| `ok` | OK手势 |
