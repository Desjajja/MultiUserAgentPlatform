#!/bin/bash
# Hand controller via MQTT

MQTT_HOST="192.168.1.103"
MQTT_PORT="1883"
TOPIC="hand"

COMMANDS="beaker_setout beaker_grab beaker_release tube_setout tube_grab tube_release reset ok feedback"

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
    mosquitto_pub -h "$MQTT_HOST" -p "$MQTT_PORT" -t "$TOPIC" -m "{\"hand\":\"feedback\"}" -d 2>&1
    timeout 3 mosquitto_sub -h "$MQTT_HOST" -p "$MQTT_PORT" -t "hand/feedback" -C 1 -v 2>/dev/null || echo "no_feedback"
    exit $?
fi

mosquitto_pub -h "$MQTT_HOST" -p "$MQTT_PORT" -t "$TOPIC" -m "{\"hand\":\"$CMD\"}"
echo "OK: $CMD"
