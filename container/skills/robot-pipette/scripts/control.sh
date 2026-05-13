#!/bin/bash
# Pipette controller via MQTT

MQTT_HOST="192.168.1.103"
MQTT_PORT="1883"
TOPIC="pipette"

COMMANDS="pipet_down pipet_up tip_down tip_up feedback"

usage() {
    echo "Usage: $0 <command>"
    echo "Commands: $COMMANDS"
    exit 1
}

[ $# -ne 1 ] && usage

CMD="$1"
if ! echo "$COMMANDS" | grep -qw "$CMD"; then
    echo "Invalid command: $CMD"
    usage
fi

# feedback 命令用于自检
if [ "$CMD" = "feedback" ]; then
    mosquitto_pub -h "$MQTT_HOST" -p "$MQTT_PORT" -t "$TOPIC" -m "{\"pipette\":\"feedback\"}" -d 2>&1
    # 等待反馈
    timeout 3 mosquitto_sub -h "$MQTT_HOST" -p "$MQTT_PORT" -t "pipette/feedback" -C 1 -v 2>/dev/null || echo "no_feedback"
    exit $?
fi

mosquitto_pub -h "$MQTT_HOST" -p "$MQTT_PORT" -t "$TOPIC" -m "{\"pipette\":\"$CMD\"}"
echo "OK: $CMD"
