"""
Preview an order (calculate amounts, match policies) without writing to DB.

ERP endpoint: POST /api/orders/preview

Returns:
  {
    "items": [...],
    "guidance_total": 27000,          // 指导价总额
    "hand_total": 23000,               // 到手价总额
    "customer_should_pay": 23000,      // 客户实付（由 settlement_mode 决定）
    "company_receivable": 27000,       // 公司应收
    "employee_advance": 4000,          // 业务员需垫付（employee_pay 才有）
    "policies_matched": [...],         // 匹配到的政策模板
    "commission_estimate": 1080        // 预估提成
  }

Usage (CLI):
    python3 preview_order.py \
        --erp-jwt "<...>" \
        --customer-id cust-001 \
        --brand-id brand-001 \
        --settlement-mode customer_pay \
        --items '[{"product_id":"p1","quantity":5,"quantity_unit":"箱","unit_price":900}]'

Usage (import):
    from preview_order import preview_order
    res = preview_order(jwt, customer_id, brand_id, "customer_pay", items)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Optional

import httpx


def preview_order(
    erp_jwt: str,
    customer_id: str,
    brand_id: str,
    settlement_mode: str,
    items: list[dict],
    *,
    policy_template_id: Optional[str] = None,
    erp_base_url: Optional[str] = None,
) -> dict:
    """Call ERP preview endpoint. Raises on HTTP error."""
    assert settlement_mode in ("customer_pay", "employee_pay", "company_pay"), \
        f"Invalid settlement_mode: {settlement_mode}"

    erp = erp_base_url or os.environ.get("ERP_BASE_URL", "http://localhost:8000")
    body = {
        "customer_id": customer_id,
        "brand_id": brand_id,
        "settlement_mode": settlement_mode,
        "items": items,
    }
    if policy_template_id:
        body["policy_template_id"] = policy_template_id

    jwt = erp_jwt if erp_jwt.startswith("Bearer ") else f"Bearer {erp_jwt}"
    r = httpx.post(
        f"{erp}/api/orders/preview",
        headers={"Authorization": jwt, "Content-Type": "application/json"},
        json=body,
        timeout=15,
    )
    if r.status_code >= 400:
        try:
            detail = r.json().get("detail", r.text[:200])
        except Exception:
            detail = r.text[:200]
        raise RuntimeError(f"Preview failed ({r.status_code}): {detail}")
    return r.json()


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--erp-jwt", required=True)
    p.add_argument("--customer-id", required=True)
    p.add_argument("--brand-id", required=True)
    p.add_argument("--settlement-mode", required=True,
                   choices=["customer_pay", "employee_pay", "company_pay"])
    p.add_argument("--items", required=True, help="JSON array of items")
    p.add_argument("--policy-template-id", default=None)
    args = p.parse_args()

    try:
        items = json.loads(args.items)
    except json.JSONDecodeError as e:
        print(f"--items must be valid JSON: {e}", file=sys.stderr)
        return 1

    try:
        res = preview_order(
            args.erp_jwt,
            args.customer_id,
            args.brand_id,
            args.settlement_mode,
            items,
            policy_template_id=args.policy_template_id,
        )
        print(json.dumps(res, ensure_ascii=False, indent=2))
        return 0
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
