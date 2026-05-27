"""
Exchange Feishu open_id for ERP JWT. Handle bind flow.

ERP endpoints used:
  POST /api/feishu/exchange-token   (X-Agent-Service-Key auth)
  POST /api/feishu/bind             (X-Agent-Service-Key auth)

Returns dict: {"access_token": str, "user_id": str, "roles": [str], "expires_in": int}
or None if open_id not bound yet (caller should prompt user for ERP credentials).

Usage (CLI):
    # Check binding
    python3 login_and_exchange.py --open-id ou_xxx

    # Bind + exchange
    python3 login_and_exchange.py --open-id ou_xxx --username zhangsan --password 123456

Usage (import):
    from login_and_exchange import exchange_or_bind
    result = exchange_or_bind(open_id, username=None, password=None)
    # result.get("access_token") -> short-lived JWT (15 min)
    # result.get("bound_now") -> True if bind happened this call
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from typing import Optional

import httpx

_JWT_CACHE: dict[str, dict] = {}  # open_id -> {token, expires_at, roles, user_id}


def _service_headers() -> dict[str, str]:
    key = os.environ.get("FEISHU_AGENT_SERVICE_KEY")
    if not key:
        raise RuntimeError("FEISHU_AGENT_SERVICE_KEY env var required")
    return {"X-Agent-Service-Key": key}


def exchange_token(open_id: str, erp_base_url: Optional[str] = None) -> Optional[dict]:
    """Try exchange. Returns dict on success, None on 404 (not bound), raises on other errors."""
    # cache hit?
    now = time.time()
    cached = _JWT_CACHE.get(open_id)
    if cached and cached["expires_at"] > now + 60:
        return cached

    erp = erp_base_url or os.environ.get("ERP_BASE_URL", "http://localhost:8000")
    r = httpx.post(
        f"{erp}/api/feishu/exchange-token",
        headers=_service_headers(),
        json={"open_id": open_id},
        timeout=10,
    )
    if r.status_code == 404:
        return None
    if r.status_code == 403:
        raise PermissionError(r.json().get("detail", "Account disabled"))
    r.raise_for_status()
    data = r.json()
    data["expires_at"] = now + data.get("expires_in", 900)  # default 15 min
    _JWT_CACHE[open_id] = data
    return data


def bind_user(
    open_id: str,
    username: str,
    password: str,
    erp_base_url: Optional[str] = None,
) -> dict:
    """Bind open_id to ERP user. Returns whatever the endpoint returns."""
    erp = erp_base_url or os.environ.get("ERP_BASE_URL", "http://localhost:8000")
    r = httpx.post(
        f"{erp}/api/feishu/bind",
        headers=_service_headers(),
        json={"open_id": open_id, "username": username, "password": password},
        timeout=10,
    )
    if r.status_code == 401:
        raise PermissionError("用户名或密码错误")
    if r.status_code == 409:
        raise RuntimeError("该 open_id 或 ERP 账号已绑定其他身份")
    r.raise_for_status()
    return r.json()


def exchange_or_bind(
    open_id: str,
    username: Optional[str] = None,
    password: Optional[str] = None,
    erp_base_url: Optional[str] = None,
) -> Optional[dict]:
    """Try exchange first; if 404 and creds given, bind then re-exchange."""
    data = exchange_token(open_id, erp_base_url=erp_base_url)
    if data is not None:
        data["bound_now"] = False
        return data
    if not (username and password):
        return None  # caller should prompt user for credentials
    bind_user(open_id, username, password, erp_base_url=erp_base_url)
    data = exchange_token(open_id, erp_base_url=erp_base_url)
    if data:
        data["bound_now"] = True
    return data


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--open-id", required=True)
    p.add_argument("--username", help="ERP username (for bind)")
    p.add_argument("--password", help="ERP password (for bind)")
    args = p.parse_args()
    try:
        result = exchange_or_bind(args.open_id, args.username, args.password)
        if result is None:
            print("NOT_BOUND: provide --username --password to bind", file=sys.stderr)
            return 2
        # print JWT + roles
        print(result.get("access_token"))
        print(f"# roles: {result.get('roles')}", file=sys.stderr)
        print(f"# user_id: {result.get('user_id')}", file=sys.stderr)
        print(f"# bound_now: {result.get('bound_now')}", file=sys.stderr)
        return 0
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
