#!/usr/bin/env python3
import argparse
import json
import os
import sys
from typing import Any, Dict, List

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAP_FILE = os.path.join(BASE_DIR, "data", "qa_map.json")


def load_map(path: str) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def normalize(text: str) -> str:
    return text.strip()


def find_answer(question: str, mapping: Dict[str, Any]) -> str:
    q = normalize(question)
    for item in mapping.get("items", []):
        questions: List[str] = item.get("questions", [])
        for src in questions:
            if normalize(src) == q:
                return item.get("answer", "")

    # Backward compatibility: if old map uses patterns, keep it as fallback match.
    for item in mapping.get("items", []):
        patterns: List[str] = item.get("patterns", [])
        if any(p in q for p in patterns):
            return item.get("answer", "")

    return mapping.get("fallback", "未命中固定问答，请补充该问题到 demo-fixed-qa 映射。")


def main() -> int:
    parser = argparse.ArgumentParser(description="Demo fixed QA (scene 5+)")
    parser.add_argument("--question", help="User question")
    parser.add_argument("--map-file", default=MAP_FILE, help="Path to qa_map.json")
    parser.add_argument("--interactive", action="store_true", help="Interactive mode")
    args = parser.parse_args()

    try:
        mapping = load_map(args.map_file)
    except Exception as exc:
        print(f"加载映射失败: {exc}", file=sys.stderr)
        return 1

    if args.interactive:
        while True:
            try:
                line = input().strip()
            except EOFError:
                break
            if not line:
                continue
            if line.lower() in {"exit", "quit"}:
                break
            print(find_answer(line, mapping))
        return 0

    if not args.question:
        print("请使用 --question 传入问题，或使用 --interactive", file=sys.stderr)
        return 2

    print(find_answer(args.question, mapping))
    return 0


if __name__ == "__main__":
    sys.exit(main())
