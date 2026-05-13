---
name: robot-pipette
description: 控制移液枪。通过MQTT发送指令控制移液枪的吸液和排液动作。触发条件：用户提到移液枪、pipette、排空、吸取等
---

# 移液枪控制

通过MQTT远程控制移液枪。

## MQTT配置

- 服务器: `192.168.1.103:1883`
- 主题: `pipette`

## 控制方式

```bash
bash scripts/control.sh <command>
```

### 命令

| 命令 | 功能 |
|------|------|
| `pipet_down` | 移液器下降（吸液） |
| `pipet_up` | 移液器上升（排液） |
| `tip_down` | 吸头下降（拾取吸头） |
| `tip_up` | 吸头上升（释放吸头） |

### 常用序列

**排空**: pipet_down → 等待2秒 → pipet_up
