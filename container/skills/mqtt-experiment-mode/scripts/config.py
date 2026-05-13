"""MQTT Experiment Mode - Configuration"""

import os

BROKER = os.getenv("MQTT_BROKER", "x2219abf.ala.cn-hangzhou.emqxsl.cn")
PORT = int(os.getenv("MQTT_PORT", "8883"))
USERNAME = os.getenv("MQTT_USERNAME", "emqx")
PASSWORD = os.getenv("MQTT_PASSWORD", "")

TLS_ENABLED = os.getenv("MQTT_TLS_ENABLED", "true").lower() in {"1", "true", "yes", "on"}
TLS_INSECURE = os.getenv("MQTT_TLS_INSECURE", "false").lower() in {"1", "true", "yes", "on"}

COMMANDS_TOPIC = os.getenv("MQTT_COMMANDS_TOPIC", "robot/open_claw/commands")
STATUS_TOPIC = os.getenv("MQTT_STATUS_TOPIC", "robot/open_claw/status")

STATE_FILE = os.getenv("MQTT_STATE_FILE", "/tmp/mqtt_experiment_mode.state")
PID_FILE = os.getenv("MQTT_PID_FILE", "/tmp/mqtt_experiment_mode.pid")

CLIENT_ID = os.getenv("MQTT_CLIENT_ID", "openclaw_experiment_mode")

INITIAL_RECONNECT_DELAY = int(os.getenv("MQTT_INITIAL_RECONNECT_DELAY", "1"))
MAX_RECONNECT_DELAY = int(os.getenv("MQTT_MAX_RECONNECT_DELAY", "60"))

DEDUP_CACHE_SIZE = int(os.getenv("MQTT_DEDUP_CACHE_SIZE", "1000"))

OPENCLAW_AGENT_ID = os.getenv("OPENCLAW_AGENT_ID", "main")
OPENCLAW_SESSION_ID = os.getenv("OPENCLAW_SESSION_ID", "")
OPENCLAW_TO = os.getenv("OPENCLAW_TO", "")
OPENCLAW_DEFAULT_CHANNEL = os.getenv("OPENCLAW_DEFAULT_CHANNEL", "")

# 推送回复给通道（默认开启）
OPENCLAW_DELIVER = os.getenv("OPENCLAW_DELIVER", "true").lower() in {"1", "true", "yes", "on"}
OPENCLAW_REPLY_CHANNEL = os.getenv("OPENCLAW_REPLY_CHANNEL", "feishu")
OPENCLAW_REPLY_TO = os.getenv("OPENCLAW_REPLY_TO", "ou_a01c96646f754c0da729d6ff3ee5557d")

DEDUP_TTL_SECONDS = int(os.getenv("MQTT_DEDUP_TTL_SECONDS", "60"))
MQTT_LOG_FILE = os.getenv("MQTT_LOG_FILE", "/tmp/mqtt_experiment_mode.log")
