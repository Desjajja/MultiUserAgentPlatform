# /home/chris/.openclaw/workspace/skills/daily-tasks/daily-tasks.py
import requests
import json
import os
import subprocess

def check_robot_arm(ip, name):
    """通过ping检查机械臂在线状态"""
    try:
        result = subprocess.run(
            ["ping", "-c", "1", "-W", "2", ip],
            capture_output=True, timeout=5
        )
        if result.returncode == 0:
            return {"name": name, "ip": ip, "status": "online", "available": True}
    except:
        pass
    return {"name": name, "ip": ip, "status": "offline", "available": False}

def check_end_effector(script_path, name):
    """通过feedback命令检查末端执行器，必须收到ok响应才算在线"""
    try:
        result = subprocess.run(
            ["bash", script_path, "feedback"],
            capture_output=True, text=True, timeout=10
        )
        output = result.stdout + result.stderr
        # 必须收到 ok 响应才算在线
        if "ok" in output.lower():
            return {"name": name, "status": "online", "available": True}
        else:
            return {"name": name, "status": "offline", "available": False}
    except Exception as e:
        return {"name": name, "status": "error", "available": False, "error": str(e)}

def run_daily_check():
    hw_data = ""
    
    # --- 1. 检查两台机械臂 (ping) ---
    hw_data += "---机械臂详情---\n"
    arms = [
        {"ip": "192.168.201.1", "name": "越疆机械臂"},
        {"ip": "192.168.1.18", "name": "睿尔曼机械臂"}
    ]
    for arm in arms:
        result = check_robot_arm(arm["ip"], arm["name"])
        hw_data += f"机械臂[{result['name']}]({result['ip']}): 状态={result['status']}, 可用性={result['available']}\n"

    # --- 2. 检查当前使用中的末端执行器 (MQTT feedback) ---
    hw_data += "---末端执行器详情---\n"
    scripts = [
        "/home/realityloop888/.openclaw/workspace/robot-pipette/scripts/control.sh",
        "/home/realityloop888/.openclaw/workspace/robot-gimbal/scripts/control.sh"
    ]
    names = ["移液枪", "云台"]
    
    for script, name in zip(scripts, names):
        result = check_end_effector(script, name)
        hw_data += f"末端[{result['name']}]: 状态={result['status']}, 可用性={result['available']}\n"

    # --- 3. 读取桌面任务 ---
    TASK_PATH = "/home/realityloop888/.openclaw/workspace/skills/daily-tasks/tasks.json"
    task_data = ""
    if os.path.exists(TASK_PATH):
        try:
            with open(TASK_PATH, 'r', encoding='utf-8') as f:
                tasks = json.load(f)
                pending = [f"[{t['priority']}] {t['task']}" for t in tasks if t.get('status') == 'pending']
                task_data = "\n".join(pending) if pending else "暂无待办"
        except: task_data = "文件读取失败"
    else:
        task_data = "未找到任务文件"

    # --- 4. 最终输出 ---
    print("===RAW_HW_DATA===")
    print(hw_data)
    print("===RAW_TASK_DATA===")
    print(task_data)

if __name__ == "__main__":
    run_daily_check()
