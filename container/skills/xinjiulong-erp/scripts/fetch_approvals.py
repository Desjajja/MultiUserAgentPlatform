"""
Fetch all pending approval items for the current user (aggregates across modules).

Uses 10+ independent endpoints and groups them by type for Agent to render a summary card.

Usage (CLI):
    python3 fetch_approvals.py --erp-jwt "<...>"

Usage (import):
    from fetch_approvals import fetch_approvals
    buckets = fetch_approvals(jwt)
    # buckets = {"receipt": [...], "policy": [...], "purchase": [...], "transfer": [...], ...}
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Optional

import httpx

ENDPOINTS = {
    "receipt":  ("/api/orders/pending-receipt-confirmation", {}),
    "policy":   ("/api/orders", {"status": "policy_pending_internal"}),
    "purchase": ("/api/purchase-orders", {"status": "pending"}),
    "transfer": ("/api/accounts/pending-transfers", {}),
    "salary":   ("/api/payroll/salary-records", {"status": "pending_approval"}),
    "leave":    ("/api/attendance/leave-requests", {"status": "pending"}),
    "advance":  ("/api/payment-requests", {"status": "pending"}),
    "expense_claim": ("/api/expense-claims", {"status": "pending"}),
    "financing_repay": ("/api/financing-orders/pending-repayments", {}),
    "expense":  ("/api/expenses", {"status": "pending"}),
}


def fetch_approvals(
    erp_jwt: str,
    erp_base_url: Optional[str] = None,
    include: Optional[list[str]] = None,
) -> dict[str, list]:
    """Fetch each endpoint. Missing/403'd endpoints return []."""
    erp = erp_base_url or os.environ.get("ERP_BASE_URL", "http://localhost:8000")
    jwt = erp_jwt if erp_jwt.startswith("Bearer ") else f"Bearer {erp_jwt}"
    headers = {"Authorization": jwt}

    buckets: dict[str, list] = {}
    with httpx.Client(headers=headers, timeout=15) as client:
        for key, (path, params) in ENDPOINTS.items():
            if include is not None and key not in include:
                continue
            try:
                r = client.get(f"{erp}{path}", params=params)
                if r.status_code in (401, 403):
                    buckets[key] = []  # no permission, empty
                    continue
                if r.status_code >= 400:
                    buckets[key] = []
                    continue
                data = r.json()
                items = data.get("items", data) if isinstance(data, dict) else data
                buckets[key] = items
            except Exception:
                buckets[key] = []
    return buckets


def summarize(buckets: dict[str, list]) -> dict[str, dict]:
    """Produce {key: {count, total_amount?}} for card rendering."""
    out: dict[str, dict] = {}
    for k, items in buckets.items():
        count = len(items)
        total = 0.0
        for item in items:
            for field in ("total_amount", "amount", "actual_pay", "days"):
                v = item.get(field)
                if v is not None:
                    try:
                        total += float(v)
                    except (TypeError, ValueError):
                        pass
                    break
        out[k] = {"count": count, "total": round(total, 2)}
    return out


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--erp-jwt", required=True)
    p.add_argument("--include", nargs="*", help="Filter to specific buckets")
    p.add_argument("--summary", action="store_true", help="Only print count/total summary")
    args = p.parse_args()
    try:
        buckets = fetch_approvals(args.erp_jwt, include=args.include)
        if args.summary:
            print(json.dumps(summarize(buckets), ensure_ascii=False, indent=2))
        else:
            print(json.dumps(buckets, ensure_ascii=False, indent=2))
        return 0
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
