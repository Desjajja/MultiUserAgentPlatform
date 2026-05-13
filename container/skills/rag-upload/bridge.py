#!/usr/bin/env python3
"""
RAG Knowledge Base Operations against http://localhost:7001
Authoritative API (per /openapi.json):
  POST   /api/knowledge/search
  POST   /api/knowledge/add
  POST   /api/knowledge/upload                (multipart file)
  DELETE /api/knowledge/document/{doc_id}     (singular)

There is no list-all endpoint; the legacy `list` subcommand has been removed
and `reupload` now requires an explicit --doc-id.
"""

import argparse
import os
import sys

import requests

BASE_URL = "http://localhost:7001"
NO_PROXY = {"http": None, "https": None}
TIMEOUT = 30


def search(query, limit=3):
    try:
        resp = requests.post(
            f"{BASE_URL}/api/knowledge/search",
            json={"query": query, "limit": limit},
            proxies=NO_PROXY,
            timeout=TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
        result = (data.get("result") or "").strip()
        if result:
            print(result)
        else:
            print("⚠️  未命中")
        return result
    except Exception as e:
        print(f"❌ 检索失败: {e}")
        return None


def add_text(text, metadata=None, doc_id=None):
    payload = {"text": text, "metadata": metadata or {}}
    if doc_id:
        payload["doc_id"] = doc_id
    try:
        resp = requests.post(
            f"{BASE_URL}/api/knowledge/add",
            json=payload,
            proxies=NO_PROXY,
            timeout=TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
        if data.get("success"):
            print(f"✅ 已添加，doc_id={data.get('doc_id')}")
            return data.get("doc_id")
        print(f"❌ 添加失败: {data}")
        return None
    except Exception as e:
        print(f"❌ 添加失败: {e}")
        return None


def delete_document(doc_id, file_path=None):
    try:
        resp = requests.delete(
            f"{BASE_URL}/api/knowledge/document/{doc_id}",
            proxies=NO_PROXY,
            timeout=TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
        if data.get("success"):
            print(f"✅ RAG 文档已删除: {doc_id}")
        else:
            print(f"⚠️ RAG 删除返回: {data}")
    except Exception as e:
        print(f"❌ RAG 删除失败: {e}")

    if file_path and os.path.exists(file_path):
        try:
            os.remove(file_path)
            print(f"✅ 本地文件已删除: {file_path}")
        except Exception as e:
            print(f"❌ 本地文件删除失败: {e}")


def upload_document(file_path):
    if not os.path.exists(file_path):
        print(f"❌ 文件不存在: {file_path}")
        return None
    try:
        with open(file_path, "rb") as fh:
            files = {"file": (os.path.basename(file_path), fh)}
            resp = requests.post(
                f"{BASE_URL}/api/knowledge/upload",
                files=files,
                proxies=NO_PROXY,
                timeout=60,
            )
            resp.raise_for_status()
            data = resp.json()
            if data.get("success"):
                print("✅ 上传成功!")
                print(f"   文件名: {data.get('filename')}")
                print(f"   Doc ID: {data.get('doc_id')}")
                return data.get("doc_id")
            print(f"❌ 上传失败: {data}")
            return None
    except Exception as e:
        print(f"❌ 上传失败: {e}")
        return None


def reupload_document(file_path, old_doc_id):
    if not old_doc_id:
        print(
            "❌ reupload 必须显式传 --doc-id；"
            "上游无 list-all 端点，无法按文件名自动查找旧文档"
        )
        return None
    print(f"🗑️ 删除旧文档: {old_doc_id}")
    delete_document(old_doc_id)
    print(f"📤 上传新文档: {file_path}")
    return upload_document(file_path)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="RAG Knowledge Base Operations")
    parser.add_argument(
        "action",
        choices=["search", "add", "upload", "delete", "reupload"],
        help="Action to perform",
    )
    parser.add_argument("--query", help="Search query (for 'search')")
    parser.add_argument(
        "--limit", type=int, default=3, help="Search result limit (default 3)"
    )
    parser.add_argument("--text", help="Text content (for 'add')")
    parser.add_argument(
        "--file", help="File path (for 'upload'/'reupload'/'delete' local cleanup)"
    )
    parser.add_argument(
        "--doc-id", help="Document ID (for 'delete'/'reupload'/'add' explicit ID)"
    )
    args = parser.parse_args()

    if args.action == "search":
        if not args.query:
            sys.exit("❌ search 需要 --query")
        search(args.query, args.limit)
    elif args.action == "add":
        if not args.text:
            sys.exit("❌ add 需要 --text")
        add_text(args.text, doc_id=args.doc_id)
    elif args.action == "upload":
        if not args.file:
            sys.exit("❌ upload 需要 --file")
        upload_document(args.file)
    elif args.action == "delete":
        if not args.doc_id:
            sys.exit("❌ delete 需要 --doc-id")
        delete_document(args.doc_id, args.file)
    elif args.action == "reupload":
        if not args.file:
            sys.exit("❌ reupload 需要 --file")
        reupload_document(args.file, args.doc_id)
