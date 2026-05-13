#!/usr/bin/env -S /Users/realityloop/.openclaw/workspace-exec-robot/skills/chassis-move/.venv/bin/python3
import argparse
import json
import os
import socket
import ssl
import sys
import threading
import time

import paho.mqtt.client as mqtt

TRACE_ID = os.environ.get("OPENCLAW_TRACE_ID") or None
TRACE_ID_SHORT = os.environ.get("OPENCLAW_TRACE_SHORT") or None

BROKER = "x2219abf.ala.cn-hangzhou.emqxsl.cn"
PORT = 8883
USERNAME = os.environ.get("EMQX_USERNAME", "emqx")
PASSWORD = os.environ.get("EMQX_PASSWORD", "")
TOPIC = "semantic_nav"
CLIENT_ID = f"openclaw_pub_{socket.gethostname()}_{os.getpid()}"


def main() -> int:
    ap = argparse.ArgumentParser(description="Publish a semantic navigation label to the chassis MQTT topic.")
    ap.add_argument("label", help="Target point label from semantic_points.yaml")
    ap.add_argument("--broker", default=BROKER)
    ap.add_argument("--port", type=int, default=PORT)
    ap.add_argument("--username", default=USERNAME)
    ap.add_argument("--password", default=PASSWORD)
    ap.add_argument("--topic", default=TOPIC)
    ap.add_argument("--client-id", default=CLIENT_ID)
    ap.add_argument("--timeout", type=float, default=10.0)
    ap.add_argument("--qos", type=int, default=1, choices=[0, 1, 2])
    ap.add_argument("--retain", action="store_true")
    ap.add_argument("--insecure", action="store_true", help="Disable hostname/cert verification. Avoid unless necessary.")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument(
        "--json-payload",
        action="store_true",
        help="Wrap payload as JSON {label, trace_id, trace_id_short, ts_ms} instead of bare label string. "
             "Default OFF: chassis subscriber currently expects bare label. Switch on after consumer is upgraded.",
    )
    args = ap.parse_args()

    result = {
        "ok": False,
        "label": args.label,
        "topic": args.topic,
        "broker": args.broker,
        "port": args.port,
        "client_id": args.client_id,
        "qos": args.qos,
        "retain": args.retain,
        "published": False,
        "trace_id": TRACE_ID,
        "trace_id_short": TRACE_ID_SHORT,
        "payload_format": "json" if args.json_payload else "legacy",
    }

    if "/" in args.label.strip() or "#" in args.label.strip() or "+" in args.label.strip():
        result["error"] = "label must be a plain semantic point name, not an MQTT topic or wildcard"
        print(json.dumps(result, ensure_ascii=False))
        return 2

    if args.dry_run:
        result["ok"] = True
        result["dry_run"] = True
        print(json.dumps(result, ensure_ascii=False))
        return 0

    connected = threading.Event()
    published = threading.Event()
    errors = []

    client = mqtt.Client(client_id=args.client_id, protocol=mqtt.MQTTv311)
    client.username_pw_set(args.username, args.password)
    client.tls_set(cert_reqs=ssl.CERT_NONE if args.insecure else ssl.CERT_REQUIRED)
    client.tls_insecure_set(args.insecure)

    def on_connect(_client, _userdata, _flags, rc):
        if rc == 0:
            connected.set()
        else:
            errors.append(f"connect failed rc={rc}")

    def on_publish(_client, _userdata, _mid):
        published.set()

    client.on_connect = on_connect
    client.on_publish = on_publish

    try:
        client.connect(args.broker, args.port, keepalive=30)
        client.loop_start()

        if not connected.wait(args.timeout):
            result["error"] = errors[0] if errors else "connect timeout"
            print(json.dumps(result, ensure_ascii=False))
            return 3

        if args.json_payload:
            payload = json.dumps(
                {
                    "label": args.label,
                    "trace_id": TRACE_ID,
                    "trace_id_short": TRACE_ID_SHORT,
                    "ts_ms": int(time.time() * 1000),
                },
                ensure_ascii=False,
            )
        else:
            payload = args.label
        info = client.publish(args.topic, payload=payload, qos=args.qos, retain=args.retain)
        info.wait_for_publish(timeout=args.timeout)

        if not published.wait(args.timeout):
            result["error"] = "publish timeout"
            print(json.dumps(result, ensure_ascii=False))
            return 4

        result["ok"] = True
        result["published"] = True
        result["mid"] = info.mid
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as e:
        result["error"] = str(e)
        print(json.dumps(result, ensure_ascii=False))
        return 1
    finally:
        try:
            client.loop_stop()
        except Exception:
            pass
        try:
            client.disconnect()
        except Exception:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
