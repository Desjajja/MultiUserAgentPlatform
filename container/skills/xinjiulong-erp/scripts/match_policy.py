"""
Match active policy templates for a brand/cases/unit_price combination.

ERP endpoint: GET /api/policy-templates/templates/match

Returns list of matching templates. Possible outcomes:
  - empty  → Agent 告诉用户"没有匹配的政策，这单无法出库"
  - 1 条   → Agent 自动选用
  - 多条  → Agent 推卡片让用户挑

Usage (CLI):
    python3 match_policy.py \
        --erp-jwt "<...>" \
        --brand-id brand-001 \
        --cases 5 \
        --unit-price 900

Usage (import):
    from match_policy import match_policy
    matches = match_policy(jwt, brand_id, cases=5, unit_price=900)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Optional

import httpx


def match_policy(
    erp_jwt: str,
    brand_id: str,
    *,
    cases: Optional[int] = None,
    unit_price: Optional[float] = None,
    erp_base_url: Optional[str] = None,
) -> list[dict]:
    """Find active templates matching brand/cases/unit_price. Returns list (possibly empty)."""
    erp = erp_base_url or os.environ.get("ERP_BASE_URL", "http://localhost:8000")
    jwt = erp_jwt if erp_jwt.startswith("Bearer ") else f"Bearer {erp_jwt}"
    params: dict = {"brand_id": brand_id}
    if cases is not None:
        params["cases"] = cases
    if unit_price is not None:
        params["unit_price"] = unit_price
    r = httpx.get(
        f"{erp}/api/policy-templates/templates/match",
        headers={"Authorization": jwt},
        params=params,
        timeout=10,
    )
    if r.status_code >= 400:
        try:
            detail = r.json().get("detail", r.text[:200])
        except Exception:
            detail = r.text[:200]
        raise RuntimeError(f"Match failed ({r.status_code}): {detail}")
    data = r.json()
    if isinstance(data, dict):
        return data.get("items", [])
    return data


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--erp-jwt", required=True)
    p.add_argument("--brand-id", required=True)
    p.add_argument("--cases", type=int)
    p.add_argument("--unit-price", type=float)
    args = p.parse_args()
    try:
        matches = match_policy(
            args.erp_jwt, args.brand_id,
            cases=args.cases, unit_price=args.unit_price,
        )
        print(json.dumps(matches, ensure_ascii=False, indent=2))
        print(f"# matched: {len(matches)}", file=sys.stderr)
        return 0
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
