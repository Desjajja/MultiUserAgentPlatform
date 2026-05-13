#!/usr/bin/env python3
"""
Web Search via DuckDuckGo (no API key required)

Usage:
    python3 search.py "query" [--max 10] [--json]
    python3 search.py "query" --region cn-zh
"""

import argparse
import json
import sys

try:
    from duckduckgo_search import DDGS
except ImportError:
    print("ERROR: duckduckgo-search not installed. Run: pip install duckduckgo-search", file=sys.stderr)
    sys.exit(1)


def search(query: str, max_results: int = 10, region: str = "wt-wt", output_json: bool = False):
    results = []
    try:
        with DDGS() as ddgs:
            for r in ddgs.text(query, region=region, max_results=max_results):
                results.append({
                    "title": r.get("title", ""),
                    "url": r.get("href", ""),
                    "snippet": r.get("body", ""),
                })
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)

    if not results:
        print("No results found.", file=sys.stderr)
        sys.exit(1)

    if output_json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
        return

    for i, r in enumerate(results, 1):
        print(f"{i}. {r['title']}")
        print(f"   {r['url']}")
        print(f"   {r['snippet']}")
        print()


def main():
    parser = argparse.ArgumentParser(description="DuckDuckGo web search")
    parser.add_argument("query", help="Search query")
    parser.add_argument("--max", type=int, default=10, metavar="N", help="Max results (default: 10)")
    parser.add_argument("--region", default="wt-wt", help="Region code, e.g. cn-zh, us-en (default: wt-wt)")
    parser.add_argument("--json", action="store_true", dest="output_json", help="Output as JSON")
    args = parser.parse_args()

    search(args.query, max_results=args.max, region=args.region, output_json=args.output_json)


if __name__ == "__main__":
    main()
