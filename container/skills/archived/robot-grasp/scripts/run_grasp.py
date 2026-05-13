#!/usr/bin/env python3
import argparse
import json
import os
import sys
import time
from typing import Any, Dict, Optional

import requests


DEFAULT_TIMEOUT = 30
DEFAULT_START_DIR = "/home/x1/openclaw_api"
DEFAULT_START_CMD = "bash start_openclaw_api.sh"
TERMINAL = {"success", "failed", "cancelled"}


def env_or_default(name: str, default: Optional[str] = None) -> Optional[str]:
    value = os.getenv(name)
    return value if value not in (None, "") else default


def build_url(base_url: str, path: str) -> str:
    return f"{base_url.rstrip('/')}" + path


def headers() -> Dict[str, str]:
    token = env_or_default("OPENCLAW_API_TOKEN", "123")
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }


def post_json(url: str, payload: Dict[str, Any], timeout: int) -> Dict[str, Any]:
    response = requests.post(url, json=payload, headers=headers(), timeout=timeout)
    response.raise_for_status()
    return response.json()


def get_json(url: str, timeout: int) -> Dict[str, Any]:
    response = requests.get(url, headers=headers(), timeout=timeout)
    response.raise_for_status()
    return response.json()


def main() -> int:
    parser = argparse.ArgumentParser(description="Call the OpenClaw task API for grasp execution.")
    parser.add_argument("--base-url", default=env_or_default("OPENCLAW_API_BASE_URL", "http://100.102.62.85:8008"))
    parser.add_argument("--config", default=None, help="Optional grasp config path")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    parser.add_argument("--check-status", action="store_true", help="Check /health before submitting task")
    parser.add_argument("--start-dir", default=env_or_default("OPENCLAW_API_START_DIR", DEFAULT_START_DIR))
    parser.add_argument("--start-cmd", default=env_or_default("OPENCLAW_API_START_CMD", DEFAULT_START_CMD))
    parser.add_argument("--pipeline", default="realman_grasp", choices=["realman_grasp", "dobot_detect_move"])
    parser.add_argument("args", nargs="*", default=[])
    args = parser.parse_args()

    health_summary: Optional[Dict[str, Any]] = None
    if args.check_status:
        health_url = build_url(args.base_url, "/health")
        try:
            health_summary = get_json(health_url, args.timeout)
        except Exception as exc:
            print(json.dumps({
                "ok": False,
                "stage": "health",
                "error": f"健康检查失败：{exc}",
                "start_hint": {
                    "cwd": args.start_dir,
                    "command": args.start_cmd,
                }
            }, ensure_ascii=False))
            return 1

    tasks_url = build_url(args.base_url, "/tasks")
    payload: Dict[str, Any] = {"pipeline": args.pipeline, "args": args.args}
    if args.config:
        payload["config"] = args.config

    try:
        submitted = post_json(tasks_url, payload, args.timeout)
        task_id = submitted.get("task_id") or submitted.get("id")
        if not task_id:
            print(json.dumps({"ok": False, "stage": "submit", "result": submitted}, ensure_ascii=False))
            return 1
        state = get_json(build_url(args.base_url, f"/tasks/{task_id}"), args.timeout)
        print(json.dumps({
            "ok": True,
            "stage": "submitted",
            "health": health_summary,
            "task_id": task_id,
            "submitted": submitted,
            "state": state,
        }, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(json.dumps({
            "ok": False,
            "stage": "submit",
            "error": f"任务提交失败：{exc}",
            "start_hint": {
                "cwd": args.start_dir,
                "command": args.start_cmd,
            }
        }, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
