#!/usr/bin/env python3
"""Call the detect_move_vision_realtime HTTP API on the dobot host."""
import argparse
import json
import os
import sys
import time
from urllib import error, request

BASE_URL = os.getenv("OPENCLAW_API_BASE_URL", "http://192.168.66.154:8008")

# Bypass any HTTP(S) proxy inherited from the LaunchAgent env (e.g. Clash on
# 127.0.0.1:7890) — the dobot host is on a LAN IP that the upstream proxy
# rejects with "Connection refused". This skill talks directly to one LAN host,
# so we install an empty ProxyHandler and forget about env-level proxies.
_no_proxy_opener = request.build_opener(request.ProxyHandler({}))
request.install_opener(_no_proxy_opener)
TOKEN = os.getenv("OPENCLAW_API_TOKEN", "")
TERMINAL = {"success", "failed", "stopped"}
FINAL_TAG = {"success": "移液完成", "failed": "移液失败", "stopped": "任务已停止"}


def _headers():
    h = {"Content-Type": "application/json"}
    if TOKEN:
        h["Authorization"] = f"Bearer {TOKEN}"
    return h


def call(method, path, body=None, timeout=15):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = request.Request(BASE_URL + path, data=data, headers=_headers(), method=method)
    with request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8")
        return json.loads(raw) if raw else {}


def emit(obj):
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def cmd_health(_args):
    emit(call("GET", "/health"))
    return 0


def cmd_status(args):
    path = f"/api/pipette/tasks/{args.task_id}" if args.task_id else "/api/pipette/status"
    emit(call("GET", path))
    return 0


def cmd_stop(_args):
    emit(call("POST", "/api/pipette/stop", {}))
    return 0


def cmd_start(args):
    body = {
        "skip_home_before_vision": True,
        "no_show": True,
        "task_count": args.task_count,
    }
    if args.params_json:
        try:
            body.update(json.loads(args.params_json))
        except json.JSONDecodeError as e:
            print(f"--params-json invalid: {e}", file=sys.stderr)
            return 2
    if args.callback_url:
        body["callback_url"] = args.callback_url

    started = call("POST", "/api/pipette/start", body)
    emit({"started": started})
    task_id = (started.get("task") or {}).get("task_id")
    if not task_id:
        print("no task_id in start response", file=sys.stderr)
        return 2
    if args.no_poll:
        return 0

    while True:
        time.sleep(args.poll_interval)
        s = call("GET", "/api/pipette/status")
        task = s.get("task") or {}
        status = task.get("status")
        ps = task.get("process_state") or {}
        emit({
            "task_id": task.get("task_id"),
            "status": status,
            "phase": ps.get("phase"),
            "target_index": ps.get("target_index"),
            "message": task.get("message"),
            "result_message": task.get("result_message"),
        })
        if status in TERMINAL:
            emit({
                "final": FINAL_TAG.get(status, status),
                "task_id": task.get("task_id"),
                "status": status,
                "result_message": task.get("result_message"),
            })
            return 0 if status == "success" else 1


def main():
    ap = argparse.ArgumentParser(description="detect_move_vision_realtime HTTP client")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("health").set_defaults(fn=cmd_health)

    sp = sub.add_parser("status")
    sp.add_argument("--task-id", default=None)
    sp.set_defaults(fn=cmd_status)

    sub.add_parser("stop").set_defaults(fn=cmd_stop)

    sp = sub.add_parser("start")
    sp.add_argument("--task-count", type=int, default=4)
    sp.add_argument("--params-json", default=None,
                    help='Extra body fields as a JSON object, merged over defaults')
    sp.add_argument("--callback-url", default=None)
    sp.add_argument("--poll-interval", type=float, default=2.0)
    sp.add_argument("--no-poll", action="store_true")
    sp.set_defaults(fn=cmd_start)

    args = ap.parse_args()
    try:
        return args.fn(args)
    except error.HTTPError as e:
        print(f"HTTPError: {e.code} {e.reason}", file=sys.stderr)
        if e.fp:
            print(e.fp.read().decode("utf-8", "ignore"), file=sys.stderr)
        return 1
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
