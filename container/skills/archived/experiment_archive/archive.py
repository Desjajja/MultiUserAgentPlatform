#!/usr/bin/env python3
"""
Experiment Archive - Generate structured experiment report
"""

import requests
import json
import argparse
from datetime import datetime

BASE_URL = "http://192.168.1.106:8000"

def search_experiments(query):
    """Search experiments from lab DB"""
    try:
        resp = requests.post(f"{BASE_URL}/api/experiments/search", 
                          json={"query": query}, timeout=10)
        resp.raise_for_status()
        result = resp.json()
        return result.get("results", [])
    except Exception as e:
        print(f"❌ 搜索失败: {e}")
        return []

def get_experiment_details(exp_id):
    """Get experiment details"""
    try:
        # Try to get full details
        resp = requests.get(f"{BASE_URL}/api/experiments/{exp_id}/report", timeout=10)
        if resp.status_code == 200:
            return resp.json()
    except:
        pass
    
    # Fallback: search to get details
    resp = requests.post(f"{BASE_URL}/api/experiments/search", 
                        json={"query": exp_id}, timeout=10)
    if resp.status_code == 200:
        results = resp.json().get("results", [])
        for r in results:
            if r.get("experiment_id") == exp_id:
                return r
    return None

def generate_report(exp_id_or_query):
    """Generate structured experiment report"""
    
    # First search for experiments
    results = search_experiments(exp_id_or_query)
    
    if not results:
        # Try as direct ID
        results = [get_experiment_details(exp_id_or_query)]
    
    if not results or not results[0]:
        print("❌ 未找到实验数据")
        return
    
    # Generate report from first result
    exp = results[0]
    
    report = f"""# 📋 实验记录报告

## 基本信息
- **实验ID**: {exp.get('experiment_id', 'N/A')}
- **类型**: {exp.get('experiment_type', 'N/A')}
- **状态**: {exp.get('status', 'N/A')}
- **创建时间**: {exp.get('created_at', 'N/A')}

## 关键数据
"""
    
    # Add any available data fields
    if exp.get('data'):
        if isinstance(exp['data'], dict):
            for k, v in exp['data'].items():
                report += f"- **{k}**: {v}\n"
    
    report += f"""
## 异常标记
{', '.join(exp.get('anomaly_flags', [])) or '无'}

## 标签
{', '.join(exp.get('tags', [])) or '无'}

---

*生成时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}*
"""
    
    print(report)
    
    # Save to file
    filename = f"/home/chris/.openclaw/workspace/doc/EXP_Report_{exp_id_or_query[:8]}.md"
    with open(filename, 'w', encoding='utf-8') as f:
        f.write(report)
    print(f"\n✅ 报告已保存到: {filename}")
    
    return report

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Experiment Archive")
    parser.add_argument("action", choices=["search", "generate"], help="Action")
    parser.add_argument("--query", help="Search query")
    parser.add_argument("--exp-id", help="Experiment ID")
    
    args = parser.parse_args()
    
    if args.action == "search":
        query = args.query or args.exp_id or "experiment"
        results = search_experiments(query)
        print(f"🔍 找到 {len(results)} 个实验:\n")
        for i, r in enumerate(results, 1):
            print(f"{i}. {r.get('experiment_id')}")
            print(f"   类型: {r.get('experiment_type')}")
            print(f"   状态: {r.get('status')}")
            print()
    elif args.action == "generate":
        exp_id = args.exp_id or args.query
        if not exp_id:
            print("❌ 需要 --exp-id 参数")
        else:
            generate_report(exp_id)
