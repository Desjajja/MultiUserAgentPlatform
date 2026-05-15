import requests
import json
import os

def finalize_archive(exp_id):
    # 1. 配置 RealityLoop B 电脑归档接口
    ARCHIVE_URL = f"http://192.168.1.106/api/archive"
    
    # 2. 预设本地归档路径 (Windows 桌面)
    # 这里的 'chris' 记得改为你的 Windows 用户名
    LOCAL_STORAGE = "/mnt/c/Users/chris/Desktop/EXP_ARCHIVE/"
    
    if not os.path.exists(LOCAL_STORAGE):
        os.makedirs(LOCAL_STORAGE)

    payload = {
        "exp_id": exp_id,
        "action": "bundle_data",
        "save_path": LOCAL_STORAGE
    }

    try:
        # 向 B 电脑请求封存数据
        response = requests.post(ARCHIVE_URL, json=payload, timeout=20)
        
        if response.status_code == 200:
            data = response.json()
            # 假设返回了归档后的文件列表
            return {
                "status": "success",
                "files": [
                    "raw_data.csv", 
                    "robot_actions.json", 
                    "ph_curve.png", 
                    "anomaly_log.json"
                ],
                "storage_path": LOCAL_STORAGE + exp_id
            }
    except Exception as e:
        return {"status": "error", "message": str(e)}

if __name__ == "__main__":
    # 模拟归档
    import sys
    res = finalize_archive("EXP-2026-0304-001")
    print(json.dumps(res))