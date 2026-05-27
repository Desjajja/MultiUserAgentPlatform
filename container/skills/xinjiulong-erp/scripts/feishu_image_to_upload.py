"""
Forward a Feishu image message to ERP /api/uploads.

Flow:
  1. Get Feishu tenant_access_token (cached per process)
  2. Download image bytes from Feishu API using message_id + image_key
  3. POST to ERP /api/uploads as multipart/form-data
  4. Return the URL string (relative path) that ERP stored

Usage (CLI):
    python3 feishu_image_to_upload.py \
        --message-id om_xxx \
        --image-key img_xxx \
        --erp-jwt "Bearer <...>"

Usage (import):
    from feishu_image_to_upload import feishu_image_to_erp
    url = feishu_image_to_erp(message_id, image_key, erp_jwt)
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from typing import Optional

import httpx

FEISHU_BASE = "https://open.feishu.cn/open-apis"
_TOKEN_CACHE = {"token": None, "expires_at": 0.0}


def _get_tenant_token(app_id: str, app_secret: str) -> str:
    """Cached fetch of tenant_access_token (valid ~2h)."""
    now = time.time()
    if _TOKEN_CACHE["token"] and _TOKEN_CACHE["expires_at"] > now + 60:
        return _TOKEN_CACHE["token"]

    r = httpx.post(
        f"{FEISHU_BASE}/auth/v3/tenant_access_token/internal",
        json={"app_id": app_id, "app_secret": app_secret},
        timeout=10,
    )
    r.raise_for_status()
    data = r.json()
    if data.get("code") != 0:
        raise RuntimeError(f"Feishu token error: {data}")
    _TOKEN_CACHE["token"] = data["tenant_access_token"]
    _TOKEN_CACHE["expires_at"] = now + data["expire"]
    return _TOKEN_CACHE["token"]


def download_feishu_image(
    message_id: str,
    image_key: str,
    app_id: Optional[str] = None,
    app_secret: Optional[str] = None,
) -> bytes:
    """Download image bytes from Feishu."""
    app_id = app_id or os.environ["FEISHU_APP_ID"]
    app_secret = app_secret or os.environ["FEISHU_APP_SECRET"]
    tok = _get_tenant_token(app_id, app_secret)

    url = f"{FEISHU_BASE}/im/v1/messages/{message_id}/resources/{image_key}"
    r = httpx.get(url, params={"type": "image"}, headers={"Authorization": f"Bearer {tok}"}, timeout=30)
    if r.status_code != 200:
        raise RuntimeError(f"Feishu image download failed: {r.status_code} {r.text[:200]}")
    return r.content


def upload_to_erp(
    image_bytes: bytes,
    erp_jwt: str,
    filename: str = "image.jpg",
    content_type: str = "image/jpeg",
    erp_base_url: Optional[str] = None,
) -> str:
    """POST image to ERP /api/uploads. Returns relative URL."""
    erp = erp_base_url or os.environ.get("ERP_BASE_URL", "http://localhost:8000")
    files = {"file": (filename, image_bytes, content_type)}
    jwt = erp_jwt if erp_jwt.startswith("Bearer ") else f"Bearer {erp_jwt}"
    r = httpx.post(f"{erp}/api/uploads", files=files, headers={"Authorization": jwt}, timeout=30)
    if r.status_code >= 400:
        raise RuntimeError(f"ERP upload failed: {r.status_code} {r.text[:200]}")
    return r.json()["url"]


def feishu_image_to_erp(
    message_id: str,
    image_key: str,
    erp_jwt: str,
    *,
    filename: str = "image.jpg",
    app_id: Optional[str] = None,
    app_secret: Optional[str] = None,
    erp_base_url: Optional[str] = None,
) -> str:
    """End-to-end: Feishu image → ERP URL."""
    data = download_feishu_image(message_id, image_key, app_id=app_id, app_secret=app_secret)
    return upload_to_erp(data, erp_jwt=erp_jwt, filename=filename, erp_base_url=erp_base_url)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--message-id", required=True)
    p.add_argument("--image-key", required=True)
    p.add_argument("--erp-jwt", required=True, help="Bearer <token> or just <token>")
    p.add_argument("--filename", default="image.jpg")
    args = p.parse_args()
    try:
        url = feishu_image_to_erp(
            args.message_id, args.image_key, args.erp_jwt, filename=args.filename
        )
        print(url)
        return 0
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
