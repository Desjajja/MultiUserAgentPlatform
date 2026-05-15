---
name: analyze-result
description: |
  实验结果多模态分析。基于当前 LLM 已具备的多模态能力，把用户提供的实验结果图（色谱图/光谱/曲线/读数/拍照）+ 可选的实验上下文（experiment-card / lab-db 历史） 做综合判读，回出问题诊断、与历史对比、下一步建议。
  触发词：
    - 看看实验结果有什么问题 / 分析下结果 / 解读这张图
    - 看一下这个色谱图 / 看一下这条曲线 / 看一下读数
    - 实验结果有问题吗 / 跟上次比怎么样 / 这个 peak 正常吗
  适用场景：用户消息里**已经带了一张图**（frontdesk a2a 已把附件 copy 到 /workspace/inbox/...），或用户给出明确历史 exp_id 让你对比。
  本 skill 不抓图，不发图——只看图给结论。抓图请用 image-fetch / lab-monitor。
allowed_tools:
  - Read
  - Bash
---

# analyze-result

实验结果多模态分析 skill。LLM 看图 + 上下文 → 出结论。

## 输入来源（按优先级）

1. **a2a 附件**：当前会话 inbox 里 `[file: xxx.jpg|png — saved to /workspace/inbox/a2a-*/xxx.jpg]` 这类附件。直接用绝对路径 Read 文件，多模态推理。
2. **用户上传**：用户在飞书消息里贴的图。同上，已被 host 落到 inbox。
3. **历史对比**：用户给出 `exp_id`（如 EXP-20260515-001）→ 让 frontdesk 先派 labops-worker 用 lab-db / experiment-archive 拿历史 summary.md 和 raw/ 下的图，再回头到本 skill 综合判读。

## 执行流程

### Step 1 — 验证输入

- 找消息里的 `[file: ... — saved to <abs_path>]` 标记，列出所有图路径。
- 一张都没有 → **不要瞎编**。回 `text=没看到图片附件，请先把实验结果图贴过来或用 image-fetch 抓一帧。` `status=failed`。

### Step 2 — 多模态分析（LLM 直接看图，不调外部 API）

按下面 5 个维度逐条判读，**每个维度一行**：

| 维度 | 内容 |
|---|---|
| 1. 图类型 | 色谱图 / 光谱 / 读数面板 / 仪器界面截图 / 实验台照片 / 其它 |
| 2. 关键观察 | 峰位、峰高、基线、信噪比、报错文字、异常颜色等具体可见特征 |
| 3. 与预期对比 | 如有 experiment-card 的预期值则对比；没有则按经验判断"看起来正常吗" |
| 4. 异常诊断 | 如有异常，给出**候选根因（≥2 条）**，按可能性排序 |
| 5. 建议下一步 | 重测 / 调参 / 联系操作员 / 走 ppe-recheck / 数据存档归类 |

### Step 3 — 历史对比（仅当用户给了 exp_id 或"跟上次比"）

让 frontdesk 先派 labops-worker 拿历史：
- `lab-db` 查 `exp_id` 的 row → 拿 `params` / `notes`
- `experiment-archive` 的 `/workspace/archives/{exp_id}/raw/` 拿历史图（如有）

然后回到本 skill，把当前图 + 历史图并排判读，输出"差异表"：

```
| 项 | 当前 | 历史(exp_id=...) | Δ |
|---|---|---|---|
| 主峰位 | 4.2 min | 4.1 min | +0.1 |
| 主峰高 | 8.4e5 | 7.9e5 | +6% |
| 基线漂移 | 平稳 | 1% drift | 改善 |
```

### Step 4 — 输出

格式：
```
🔬 实验结果分析（{图路径}）

类型：{Step2.1}
观察：{Step2.2}
对比预期：{Step2.3}
异常诊断：
  - {候选 1，可能性 X}
  - {候选 2，可能性 Y}
建议：{Step2.5}
```

历史对比追加在末尾。

## 硬性规则

- **不编**：图里看不清的东西就说"看不清，建议重传高分辨率图"。不要凭历史经验给具体数字。
- **不抓图**：本 skill 不调 image-fetch / lab-monitor。要新图请让用户/上游 worker 先抓。
- **不发图**：分析结果是纯文字（必要时引用图路径）。frontdesk 已经在 inbox 里有图，无需再 send_file 一次。
- **多张图**：每张图按 Step2 输出一段，然后整体一段"综合结论"。
- **置信度**：诊断里如果不确定，明确写"低置信度 / 仅供参考"，让 frontdesk 决定要不要追问用户。

## 错误处理

| 情况 | 处理 |
|---|---|
| 没看到附件 | text="没看到图片附件" + status=failed |
| 文件路径不存在 / 读不开 | text="图片路径 {path} 不可读" + status=failed |
| 图分辨率太低看不清 | text 里写"分辨率不足看不清细节,建议..." + status=ok（不算失败，但说明） |
| 历史对比但 lab-db 没记录 | 跳过 Step3，正常输出 Step2，末尾追加"该 exp_id 在 lab-db 中无历史记录" |
