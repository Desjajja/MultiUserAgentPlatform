#!/bin/bash
# Gimbal controller via MQTT

MQTT_HOST="192.168.1.103"
MQTT_PORT="1883"
TOPIC="gimbal"

DIR_COMMANDS="up down left right center stop feedback"

# Handle feedback command for self-check
if [ "$1" = "feedback" ]; then
    mosquitto_pub -h "$MQTT_HOST" -p "$MQTT_PORT" -t "$TOPIC" -m "{\"gimbal\":\"feedback\"}" -d 2>&1
    timeout 3 mosquitto_sub -h "$MQTT_HOST" -p "$MQTT_PORT" -t "gimbal/feedback" -C 1 -v 2>/dev/null || echo "no_feedback"
    exit $?
fi

usage() {
    echo "Usage: $0 <command>"
    echo ""
    echo "Direction commands: $DIR_COMMANDS"
    echo "Angle commands: pitch_<0-180>, yaw_<0-180>"
    echo "Example: $0 up"
    echo "         $0 pitch_45"
    echo "         $0 yaw_90"
    exit 1
}

[ $# -ne 1 ] && usage

CMD="$1"

# Handle pitch angle command
if [[ "$CMD" == pitch_* ]]; then
    ANGLE="${CMD#pitch_}"
    if ! [[ "$ANGLE" =~ ^[0-9]+$ ]] || [ "$ANGLE" -gt 180 ]; then
        echo "Invalid pitch angle (0-180): $ANGLE"
        exit 1
    fi
    mosquitto_pub -h "$MQTT_HOST" -p "$MQTT_PORT" -t "$TOPIC" -m "{\"gimbal_pitch\":\"$ANGLE\"}"
    echo "OK: pitch $ANGLE"
    exit 0
fi

# Handle yaw angle command
if [[ "$CMD" == yaw_* ]]; then
    ANGLE="${CMD#yaw_}"
    if ! [[ "$ANGLE" =~ ^[0-9]+$ ]] || [ "$ANGLE" -gt 180 ]; then
        echo "Invalid yaw angle (0-180): $ANGLE"
        exit 1
    fi
    mosquitto_pub -h "$MQTT_HOST" -p "$MQTT_PORT" -t "$TOPIC" -m "{\"gimbal_yaw\":\"$ANGLE\"}"
    echo "OK: yaw $ANGLE"
    exit 0
fi

# Handle direction command
if echo "$DIR_COMMANDS" | grep -qw "$CMD"; then
    mosquitto_pub -h "$MQTT_HOST" -p "$MQTT_PORT" -t "$TOPIC" -m "{\"gimbal\":\"$CMD\"}"
    echo "OK: $CMD"
    exit 0
fi

echo "Invalid command: $CMD"
usage
