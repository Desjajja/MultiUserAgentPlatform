#!/usr/bin/env python3
"""
Lab Database Operations
- Ingest experiment data
- Search similar experiments
- Get experiment report
"""

import requests
import sys
import json
import argparse

BASE_URL = "http://localhost:7001"

def ingest_experiment(exp_id, data, experiment_type="extraction"):
    """Ingest experiment data"""
    try:
        payload = {
            "experiment_id": exp_id,
            "experiment_type": experiment_type,
            "data": json.loads(data) if isinstance(data, str) else data
        }
        resp = requests.post(f"{BASE_URL}/api/experiments/ingest", json=payload, timeout=10)
        resp.raise_for_status()
        result = resp.json()
        print(f"✅ 实验数据已写入: {exp_id}")
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return result
    except Exception as e:
        print(f"❌ 写入失败: {e}")
        return None

def search_experiments(query):
    """Search similar experiments"""
    try:
        payload = {"query": query}
        resp = requests.post(f"{BASE_URL}/api/experiments/search", json=payload, timeout=10)
        resp.raise_for_status()
        result = resp.json()
        
        if result.get("results"):
            print(f"🔍 找到 {len(result['results'])} 个相似实验:\n")
            for i, r in enumerate(result["results"], 1):
                print(f"{i}. {r.get('experiment_id', 'N/A')}")
                print(f"   相似度: {r.get('score', 'N/A')}")
                print(f"   摘要: {r.get('summary', 'N/A')[:100]}...")
                print()
        else:
            print("未找到相似实验")
        return result
    except Exception as e:
        print(f"❌ 搜索失败: {e}")
        return None

def get_experiment_report(exp_id):
    """Get experiment report"""
    try:
        resp = requests.get(f"{BASE_URL}/api/experiments/{exp_id}/report", timeout=10)
        resp.raise_for_status()
        result = resp.json()
        
        print(f"📊 实验报告: {exp_id}")
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return result
    except Exception as e:
        print(f"❌ 查询失败: {e}")
        return None

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Lab Database Operations")
    parser.add_argument("action", choices=["ingest", "search", "report"], help="Action")
    parser.add_argument("--exp-id", help="Experiment ID")
    parser.add_argument("--data", help="JSON data for ingest")
    parser.add_argument("--query", help="Search query")
    
    args = parser.parse_args()
    
    if args.action == "ingest":
        if not args.exp_id or not args.data:
            print("❌ 需要 --exp-id 和 --data 参数")
            sys.exit(1)
        ingest_experiment(args.exp_id, args.data)
    elif args.action == "search":
        if not args.query:
            print("❌ 需要 --query 参数")
            sys.exit(1)
        search_experiments(args.query)
    elif args.action == "report":
        if not args.exp_id:
            print("❌ 需要 --exp-id 参数")
            sys.exit(1)
        get_experiment_report(args.exp_id)
