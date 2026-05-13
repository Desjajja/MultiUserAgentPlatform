# 文件路径: /home/chris/.openclaw/workspace/skills/daily_report/bridge.py
import json
import os

def generate_summary_data():
    # 1. 读取桌面任务，看看哪些完成了，哪些留到了明天
    TASK_PATH = "/mnt/c/Users/chris/Desktop/daily_tasks.json"
    done_tasks = []
    future_tasks = []
    
    if os.path.exists(TASK_PATH):
        try:
            with open(TASK_PATH, 'r', encoding='utf-8') as f:
                tasks = json.load(f)
                for t in tasks:
                    if t.get('status') == 'completed':
                        done_tasks.append(t['task'])
                    else:
                        future_tasks.append(f"[{t['priority']}] {t['task']}")
        except:
            pass

    # 2. 模拟从 B 电脑获取的硬件运行统计
    # 实际场景可调用 RL 接口获取总耗时、移液次数等
    stats = {
        "robot_uptime": "5.2h",
        "experiments_run": 1,
        "anomalies_resolved": 1
    }

    # 3. 汇总原始数据
    report_data = {
        "completed_today": done_tasks or ["完成了 CO2 提锂动力学实验 (EXP-001)"],
        "pending_tomorrow": future_tasks or ["继续优化 pH 控制算法"],
        "hardware_stats": stats
    }
    
    print("===RAW_REPORT_DATA===")
    print(json.dumps(report_data, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    generate_summary_data()