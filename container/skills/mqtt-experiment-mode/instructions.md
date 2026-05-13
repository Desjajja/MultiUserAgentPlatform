---
name: mqtt-experiment-mode
description: 本地指令开关实验模式；开启后订阅 MQTT 指令并把 raw_text 注入 OpenClaw agent 执行。
---

# MQTT 实验模式

## 行为规则

- 实验模式开关仅来自本地输入：`enable/disable`
- `experiment_mode=false` 时不订阅 `robot/open_claw/commands`
- `experiment_mode=true` 时订阅并处理 `voice_command`

## 使用

```bash
# 启动守护进程（常驻）
python3 {baseDir}/scripts/control.py start

# 开启实验模式（会自动确保守护进程已启动）
python3 {baseDir}/scripts/control.py enable

# 查看状态
python3 {baseDir}/scripts/control.py status

# 关闭实验模式
python3 {baseDir}/scripts/control.py disable

# 停止守护进程
python3 {baseDir}/scripts/control.py stop
```

## MQTT 指令格式

```json
{
  "action": "voice_command",
  "raw_text": "打开 QQ 音乐",
  "timestamp": 1234567890
}
```

## 配置

在运行前设置环境变量（推荐）：

```bash
export MQTT_BROKER=x2219abf.ala.cn-hangzhou.emqxsl.cn
export MQTT_PORT=8883
export MQTT_USERNAME=emqx
export MQTT_PASSWORD=12345678
export MQTT_TLS_ENABLED=true
```

可选：

- `MQTT_COMMANDS_TOPIC`（默认 `robot/open_claw/commands`）
- `MQTT_STATUS_TOPIC`（默认 `robot/open_claw/status`）
- `OPENCLAW_DEFAULT_CHANNEL`（例如 `feishu`）

## 健壮性

- PID 文件控制（`/tmp/mqtt_experiment_mode.pid`）
- 状态持久化（`/tmp/mqtt_experiment_mode.state`）
- 异常不崩溃、自动重连（指数退避）
- 去重：`timestamp + raw_text`
- MQTT 回调线程非阻塞（执行放入工作队列）
