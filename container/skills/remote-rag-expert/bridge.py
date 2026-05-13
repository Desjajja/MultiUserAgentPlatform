#!/usr/bin/env python3
"""
Remote RAG Expert — queries the local RAG server at localhost:7001.
Uses POST /api/knowledge/search per the authoritative OpenAPI schema at
http://localhost:7001/openapi.json.
"""
import requests
import sys

BASE_URL = "http://localhost:7001"
NO_PROXY = {"http": None, "https": None}
TIMEOUT = 30


def call_rag(query, limit=3):
    try:
        resp = requests.post(
            f"{BASE_URL}/api/knowledge/search",
            json={"query": query, "limit": limit},
            proxies=NO_PROXY,
            timeout=TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
        answer = (data.get("result") or "").strip()
        if answer:
            print(answer)
        else:
            print("【未命中】RAG 知识库中未检索到相关内容")
            sys.exit(2)
    except Exception as e:
        print(f"【连接异常】RAG 后端不可达: {e}")
        sys.exit(1)


if __name__ == "__main__":
    if len(sys.argv) > 1:
        call_rag(sys.argv[1])
    else:
        sys.exit("usage: bridge.py <query>")
