#!/usr/bin/env python3
"""Thin HTTP client to the semantic-router service at 127.0.0.1:7102.

Graceful-degrade contract: if the service is unreachable or errors out,
return a JSON object with confidence=0.0 and a non-empty `error` field, so
the caller (main) can transparently fall back to the original DISPATCH flow.

Never raises to stdout/stderr in a way that would crash main's tool-use loop.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict

import requests

BASE_URL = os.environ.get("SEMANTIC_ROUTER_URL", "http://127.0.0.1:7102")
TIMEOUT = float(os.environ.get("SEMANTIC_ROUTER_TIMEOUT", "3.0"))


def _print_json(obj: Dict[str, Any]) -> None:
    print(json.dumps(obj, ensure_ascii=False))


def _fallback(reason: str, http_status: int | None = None) -> Dict[str, Any]:
    return {
        "matched_skill": None,
        "confidence": 0.0,
        "top_3": [],
        "is_unambiguous": False,
        "latency_ms": 0.0,
        "decision": "fallback_to_llm",
        "mode": None,
        "error": reason,
        "http_status": http_status,
    }


def cmd_route(args: argparse.Namespace) -> int:
    payload: Dict[str, Any] = {"user_message": args.message}
    if args.trace_id:
        payload["trace_id"] = args.trace_id
    if args.mode_override:
        payload["mode_override"] = args.mode_override

    try:
        resp = requests.post(f"{BASE_URL}/route", json=payload, timeout=TIMEOUT)
    except requests.exceptions.ConnectionError:
        _print_json(_fallback("service_unreachable"))
        return 0
    except requests.exceptions.Timeout:
        _print_json(_fallback("service_timeout"))
        return 0
    except Exception as exc:
        _print_json(_fallback(f"client_error: {exc}"))
        return 0

    if resp.status_code != 200:
        _print_json(_fallback(f"http_{resp.status_code}", http_status=resp.status_code))
        return 0

    try:
        body = resp.json()
    except ValueError:
        _print_json(_fallback("non_json_response"))
        return 0

    _print_json(body)
    return 0


def cmd_health(args: argparse.Namespace) -> int:
    try:
        resp = requests.get(f"{BASE_URL}/health", timeout=TIMEOUT)
    except Exception as exc:
        _print_json({"ok": False, "error": str(exc)})
        return 0
    try:
        _print_json(resp.json())
    except ValueError:
        _print_json({"ok": False, "error": "non_json_response", "status": resp.status_code})
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="semantic-route HTTP bridge")
    sub = parser.add_subparsers(dest="action", required=True)

    p_route = sub.add_parser("route", help="Run semantic routing on a user message")
    p_route.add_argument("--message", required=True, help="The raw user message")
    p_route.add_argument("--trace-id", default=None, help="Optional trace id (auto-generated if omitted)")
    p_route.add_argument(
        "--mode-override",
        default=None,
        choices=["off", "shadow", "active"],
        help="Override service mode for this single call",
    )
    p_route.set_defaults(func=cmd_route)

    p_health = sub.add_parser("health", help="Check service health")
    p_health.set_defaults(func=cmd_health)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as exc:
        _print_json(_fallback(f"bridge_crash: {exc}"))
        sys.exit(0)
