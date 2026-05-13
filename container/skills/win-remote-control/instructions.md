---
name: win_remote_control
description: 通过局域网 HTTP API 远程控制 Windows 电脑 B，用于截图、视觉定位、鼠标点击、文字输入、打开网页和基础桌面交互。适用于用户提到"远程操作电脑""截图""点击某个按钮/图标""输入文字""打开网页/程序"等场景。仅在远端控制服务在线时使用；默认使用 smart_click（a11y→OCR→视觉 三级降级），有文字标签的元素一律走 smart_click；纯图标走 patch_click/finalize 视觉两阶段；避免默认依赖 key、hotkey；run_exe 仅用于已验证可用的目标。
---

# Win Remote Control SKILL

通过局域网 HTTP API 远程控制 Windows B（默认 `http://192.168.66.246:8000`）。本 SKILL 包含 Chromeleon 7 离子色谱（IC）实验完整 SOP 与所有 win-remote-control 通用工具指南。

**coords_status: validated_2026-04-25_92pct** — 24/26 click-needing step 已校准（Step 25 Start + Step 21 模态行待 demo 当天补）。
**calibration_mode: ui_only_no_instrument_connection** — UI click 必须发,不要求物理仪器响应。

## 指令路由表（LLM 收到任务时**先**查这张表决定走哪条路径）

| 用户触发词 | 对应 SOP 段 | 起始 step | 缩水允许? | 备注 |
|----------|-----------|---------|---------|------|
| 启动离子色谱实验 / 跑离子色谱 / 完整跑 / 做 IC / 启动 IC / 完整 SOP | 完整 28 步 SOP | **Step 1** | ❌ **严禁** | 必须从 Step 1 开始顺序执行 |
| 复制 Li-test 模板 / 创建实验卡片 / 加 sequence 到 queue | 完整 28 步 SOP | **Step 8** 起 | 部分允许 | 跳过 pump 健康检查段，进入 Data 视图 |
| 切 tab / 切到 X / 看状态 / 拿一帧屏幕 / 截图 | 诊断查询段（不走 SOP） | n/a | ✅ 单步 | 单次操作返回结果 |
| 看下当前 tab / 当前 Chromeleon 状态 / a11y_tree 查 | 诊断查询段 | n/a | ✅ 单步 | 用 `a11y_tree` 或 `a11y_element` 主路径,multimodal 兜底 |

**铁律**:
- 业务执行类(完整 SOP / 起始 Step ≠ n/a)**必须**从指令路由表里指定的"起始 step"开始,**顺序执行后续每一步**,不得跳跃。
- 诊断查询类(起始 step = n/a)允许单次操作。
- **任何"启动"/"跑"/"做(+实验)"/"完整执行"语义,默认走完整 SOP,从 Step 1 起**。除非用户明确指出从中间某步起。

## 28 步 SOP 大纲（只列名 + 关键前置条件,详细见下方"SOP 主流程详细指令"）

| Step | 阶段 | 动作 | 关键前置 |
|------|-----|------|---------|
| 1 | A.连接 | 校验 Chromeleon Console 在前台 + Instruments 视图 | Chromeleon 启动并最大化 |
| 2 | A.连接 | 点击 LOCSS-LAB 下的 HPIC | HPIC 在仪器树可见 |
| 3 | A.连接 | 等待 Connecting 对话框消失 | 网络通,30s 超时即 abort |
| 4 | A.连接 | 点击顶部 Pump_ECD tab | tab 行可见 |
| 5 | A.连接 | 校验 Pump_ECD 为 On(verify only) | Pump_ECD 面板已加载 |
| 6 | A.连接 | (可选自检)点击 Pump_ECD Off | calibration_mode=ui_only 时只测 click 命中 |
| 7 | A.连接 | (可选自检)点击 Pump_ECD On | 同上 |
| 8 | B.复制 | 切到 Data 视图(左下导航) | 左下导航 Instruments / Data / eWorkflows 可见 |
| 9 | B.复制 | 展开 DATA → Instrument Data → 2022 → realityloop | Data 树根可见 |
| 10 | B.复制 | 右键点击模板 sequence Li-test | realityloop 文件夹已选中,Li-test 可见 |
| 11 | B.复制 | 在右键菜单点击 Copy | 右键菜单已弹出 |
| 12 | B.复制 | 右键点击 realityloop 文件夹 | 同上 |
| 13 | B.复制 | 在右键菜单点击 Paste | 右键菜单已弹出 |
| 14 | B.复制 | 重命名 Li-test - Copy 为 {DATE_PREFIX}-Li-test | Step 13 完成,新 sequence 已创建 |
| 15 | C.检视 | 双击新 sequence 打开编辑器 | Step 14 完成,新 sequence 在 realityloop 下 |
| 16 | C.检视 | 校验 8 行 injection 列表完整 | sequence editor 已打开 |
| 17 | C.检视 | (可选)截图存档 | 同上 |
| 18 | D.加队列 | 切回 Instruments 视图 | Step 15-17 完成 |
| 19 | D.加队列 | 点击顶部 Queue tab | Instruments 视图激活 |
| 20 | D.加队列 | 点击右侧 Add... 按钮 | Queue tab 已激活 |
| 21 | D.加队列 | 在 Add 模态选中新 sequence | Add 模态已弹出,Look in 是 realityloop |
| 22 | D.加队列 | 点击模态底部 Add 按钮 | sequence 已选中 |
| 23 | D.加队列 | 点击 Ready Check 按钮 | Queue 主表格里有该 sequence,Status=Pending |
| 24 | D.加队列 | 等待并校验 `Ready check result: Successful.` | Step 23 触发,60s 超时即 abort;**HPIC 未连/Sampler 异常时此步会 fail** |
| 25 | D.加队列 | 点击 Start 按钮 | **Step 24 必须通过**,Start 从 disabled 变 enabled |
| 26 | E.监控 | 切回 Pump_ECD tab | sequence 已 Start |
| 27 | E.监控 | 截图存档运行中状态 | 同上 |
| 28 | E.监控 | 返回 dispatcher JSON | 全部前置完成 |

## 执行约束（业务执行类必读）

1. **起始 step 不可改**:从指令路由表指定的"起始 step"开始,**严禁**跳到中间某步开干。
2. **顺序执行铁律**:Step N 完成才能做 Step N+1。`step1 → step19 → step23` 这种"自由发挥"剧本是**错误**的,LLM 必须拒绝执行。
3. **前置条件不满足 → 立即停下报告**:每个 step 的"前置"列写得很死,不满足就 abort,**严禁硬跑**。
4. **遇到以下信号必须立即停下**(不要继续往前):
   - Queue 主表格为空但 SOP 已到 Step 23 → 说明 Step 18-22 没执行成功
   - sequence editor 显示不存在或行数错 → Step 14 可能失败
   - Sampler 异常 / `Too many errors` → 物理层面停摆,不要碰 Ready Check
   - Ready Check `Failed` 或超时 → 严禁强按 Start
   - Pressure 超 4900 psi → 物理隐患,立即 abort
5. **缩水 / 跳步禁令**:任何"我觉得 Step X-Y 没必要"的解读 = 错误。SOP 是按真录屏校准过的,每一步都有理由。
6. **二次确认前提**:main 已经向用户做过二次确认(见 main 的 AGENTS.md "业务执行类派发规则")。exec-remote 不再问用户,只问 main(if 歧义)或直接报告(if 失败)。
7. **calibration_mode = ui_only_no_instrument_connection**:click 必须真发,UI 响应即算 hit;不要求物理 pump 启 / sample 进样;Step 24 Ready Check 因 HPIC 未连预期会 fail,exec-remote 应**停下报告"前置不满足"**。
8. **进度反馈**:每完成 5 step 用 `message` 给 main 一条简短中间报告(`Step N 完成,准备 Step N+1`),不阻塞执行。

## IME 防御铁律(2026-04-25 trial 3 实测踩坑)

Win11 中文版默认 Pinyin IME **拦截字母键**:`type` / `key` 命令发字母 `L/i/t/e/s` 时,IME 把它们解读为拼音输入,屏幕顶部弹出候选条,**字符不会真打进当前 input 框**。

**任何 `type` 操作前必须按以下顺序处理**:

1. **(可选)检测当前输入法状态**(不强制):
   - 调 `bridge.py a11y_tree --scope desktop` 看任务栏右下角输入法图标(中/英)
   - 看不到也可以,直接走第 2 步(无害)

2. **强制切英文输入法**(无条件做,即使可能已经是英文):
   - `bridge.py hotkey --keys shift`(单击 shift,Win11 中文 IME 切中/英 默认快捷键)
   - 或 `bridge.py hotkey --keys win+space`(切换输入法语言,跨多 IME)
   - 切完等 200-300ms

3. **然后才发 `type` 命令**:`bridge.py type --text "20260425-Li-test"`

4. **type 后立即 a11y_query 输入框内容**,验证是否正确:
   - 调 `bridge.py a11y_element --name "Sequence" --depth 6`(或对应 input 的精确名)
   - 看 `value` 字段是否含完整字母 + 数字
   - 如有 IME 候选条 visible,说明字母被吞 → 走第 5 步降级

5. **降级方案**(IME 仍拦截时):

   **方案 A:hotkey 逐字符输入**(慢但稳)
   - 把 `"20260425-Li-test"` 拆成 16 个 `hotkey --keys` 调用,逐个发字母
   - hotkey **不被 IME 拦截**(它走系统级按键,绕过 IME 的字母组合处理)
   - 例:`hotkey --keys 2` → `hotkey --keys 0` → ... → `hotkey --keys L` → ... → `hotkey --keys t`
   - **横线 `-`** 也用 hotkey:`hotkey --keys minus`(美式键盘)或 `hotkey --keys -`
   - 末尾 `bridge.py key --key enter` 提交

   **方案 B:跳过 type 改用键盘事件兜底**(更慢)
   - 同 A,本质一样,只是把 hotkey 改成 key(单键)
   - 适用于 hotkey 也被某些应用拦截的场景

   **方案 C:不可用** ❌ — bridge.py **当前无 clipboard endpoint**(2026-04-25 14 个 endpoint 全列表无 set_clipboard / paste)。**不要尝试** `clipboard paste`,会失败。

6. **应用范围**:
   - **所有 28 step 中包含 `type` 或 "输入" 动作的 step**:Step 14b(rename input),以及未来任何 sequence 名/参数输入
   - **不影响**:hotkey 类操作(Ctrl+S / Alt+Tab),它们走系统级按键,IME 不拦截
   - **不影响**:数字 / 横线 type(Pinyin IME 通常不拦截这些,但保险起见 type 前先切英文)

7. **如出现 IME 候选条占据屏幕**(任何步骤,任何时候):
   - 立刻发 `bridge.py key --key escape` 关掉
   - 然后 a11y_query 验证候选条消失,再继续

## SOP 执行前置条件（启动前必须满足）

1. Chromeleon Console **已打开**且最大化(标题栏 "Chromeleon Console")。
2. 左下角导航在 **Instruments**(蓝色高亮)。
3. **LOCSS-LAB** Instrument Controller 状态为 "running idle",HPIC 仪器在树中可见。
4. 模板 sequence **`{TEMPLATE_SEQUENCE}`**(默认 `Li-test`)已存在于 `DATA/Instrument Data/{DATA_YEAR}/{USER_FOLDER}/`。
5. 仪器进样器 vial 已就位(SOP 不负责物理装样)。
6. 用户未远程锁屏。

## 参数化变量清单

| 变量 | 默认值 | 来源 | 备注 |
|------|-------|-----|------|
| `{INSTRUMENT_NAME}` | `HPIC` | 固定 | LOCSS-LAB 下唯一仪器 |
| `{CONTROLLER_NAME}` | `LOCSS-LAB` | 固定 | Instrument Controller |
| `{DATA_YEAR}` | `2022` | 固定 | `Instrument Data/` 年份子目录 |
| `{USER_FOLDER}` | `realityloop` | 用户消息 / lab_db | 操作员个人文件夹 |
| `{TEMPLATE_SEQUENCE}` | `Li-test` | 用户消息 | 复制的模板 |
| `{DATE_PREFIX}` | 当天 YYYYMMDD | 运行时生成 | 不带空格/横线 |
| `{SEQUENCE_NAME}` | `{DATE_PREFIX}-{TEMPLATE_SEQUENCE}` | 派生 | 例:`20260425-Li-test` |
| `{METHOD_NAME}` | `SCS1-20` | 模板内置 | 不修改 |
| `{RUN_DURATION_MIN}` | `15` | 模板内置 | 单针 run time |

---

## SOP 主流程详细指令(每步:动作 + 坐标 + a11y_id + 验证)

### 阶段 A:连接仪器并校验 pump 健康(Step 1–7)

##### Step 1: 校验 Chromeleon Console 在前台 + Instruments 视图激活
- **前置**: Chromeleon Console 在前台(标题栏可见) + 左下导航 Instruments 蓝色高亮
- **前置不满足**: 停下报告"Chromeleon 不在前台 / Instruments 未激活,请用户手动切前台"
- **动作**: verify only(无 click)
- **目标**: Chromeleon Console 主窗口
- **a11y**: WindowControl name 含 `Chromeleon Console`,rect width > 1900(最大化)
- **坐标**: (960, 516)(窗口中心,verify-only 不点击)
- **验证**: a11y_element name=Chromeleon Console depth=1 → rect.width > 1900 + isOffScreen=False
- **失败**: abort,要求人工启动 Chromeleon

##### Step 2: 点击 LOCSS-LAB 下的 `{INSTRUMENT_NAME}`
- **前置**: `calibration_mode == ui_only_no_instrument_connection` 时 → 跳过此步(只走 UI 验证,不要求 HPIC 真连接)。其他模式 → HPIC 已连接 + 在仪器树可见
- **前置不满足**: (非 ui_only)HPIC 未连 → 停下报告"HPIC 未连,无法继续业务流程"
- **动作**: click
- **目标**: `HPIC` 仪器节点
- **坐标**: `(40, 183)`
- **a11y**: ListItemControl name=`HPIC`,左仪器树
- **命令**: `bridge.py click --x 40 --y 183`
- **验证**: 状态栏出现 `Instrument 'HPIC' selected`
- **特殊**: 如 HPIC 已连接,此步可能无 visual 变化 → 不视为失败

##### Step 3: 等待 Connecting 对话框消失
- **前置**: Step 2 已发起连接(非 ui_only 模式);ui_only 时直接跳过此步
- **前置不满足**: 30s 超时无对话框关闭 → 停下报告"连接超时,Instrument Controller 可能死,abort"
- **动作**: wait
- **目标**: 中央遮罩 "Connecting instrument 'HPIC' on LOCSS-LAB..." 对话框
- **超时**: 30s
- **失败**: abort(连接失败)

##### Step 4: 点击顶部 Pump_ECD tab
- **前置**: Step 1-3 通过(ui_only 模式只需 Step 1 通过);顶部 tab 行可见(8 个 tab Home/Sampler/Pump_ECD/CDet/Electrolytics/Audit/Startup/Queue 全部 a11y 可见)
- **前置不满足**: tab 行不见 → 停下报告"主区未渲染,可能 Step 1 视图判断错误,请检查 Chromeleon 状态"
- **动作**: click
- **目标**: Pump_ECD tab(顶部第 3 个)
- **坐标**: `(529, 95)`
- **a11y**: TabItemControl,name=GUID `m_6d8b20b9-a0dd-4142-a865-9e27b6a89111`(**name 是 GUID,不能用 smart_click --name**)
- **命令**: `bridge.py click --x 529 --y 95`
- **验证**: 主区显示 CD 实时数值 + Suppressor + Pump_ECD 面板

##### Step 5: 校验 Pump_ECD 为 On
- **前置**: Step 4 完成,Pump_ECD 面板已加载(CD 实时数值 + Suppressor + Flow/Pressure 可见)
- **前置不满足**: 面板未加载 → 停下报告"Pump_ECD tab 切换失败,主区仍是上一个视图"
- **动作**: verify only(无 click;失败则降级 click)
- **目标**: Pump_ECD On 按钮的绿色指示点
- **坐标参考**: On 按钮 (768, 411)
- **a11y**: ButtonControl name=`On` aid=`m_a61bc10e...`
- **验证**: pump 在 On 状态(绿色指示);如 Off → click (768, 411) 启动
- **calibration_mode=ui_only**: UI 校验绿色即可,不要求物理 pump 真启

##### Step 6: (可选自检)点击 Pump_ECD Off
- **前置**: Step 5 verify 已记录 pump 当前态;此步是**可选**自检,calibration_mode=ui_only 时只测 click 命中,non-ui_only 时验证 pump 控制链路
- **前置不满足**: (可选步骤,跳过即可,不影响后续)
- **动作**: click
- **坐标**: `(768, 456)`
- **a11y**: ButtonControl name=`Off` aid=`m_9cd91f49...`
- **命令**: `bridge.py click --x 768 --y 456`
- **验证**: Audit 表格新增 `Pump_ECD Off`(ui_only 模式可省)
- **可选**: 自检步骤,可省略直接进 Step 8

##### Step 7: (可选自检)点击 Pump_ECD On
- **前置**: Step 6 已执行(若执行)
- **前置不满足**: (可选步骤,跳过即可)。若 Step 7 执行后出现高压报警 (`pressure exceeded 4900 psi`)→ **abort**,物理隐患,严禁重试
- **动作**: click
- **坐标**: `(768, 411)`(复用 Step 5 坐标)
- **a11y**: 同 Step 5
- **命令**: `bridge.py click --x 768 --y 411`
- **验证**: Audit 新增 `Pump_ECD On`
- **失败**: 高压报警 → abort(物理隐患)

### 阶段 B:复制模板 sequence 并重命名(Step 8–14)

##### Step 8: 切到 Data 视图
- **前置**: Step 1-7 完成,Instruments 视图仍激活(左下导航 Instruments 蓝色高亮)
- **前置不满足**: 主区不在 Instruments 视图 → 停下报告"视图状态异常,可能 Step 4-7 触发了非预期视图切换"
- **动作**: click
- **目标**: 左下导航 `Data`(中间项)
- **坐标**: `(182, 933)`
- **a11y**: ListItemControl name=`Data`
- **命令**: `bridge.py click --x 182 --y 933`
- **验证**: 状态栏 `Data Vault 'DATA' selected`,主区出现 DATA 标题

##### Step 9: 展开 DATA 树到 realityloop
- **前置**: Step 8 完成,Data 视图激活(状态栏 `Data Vault 'DATA' selected`),DATA 根节点 a11y 可见(rect 在 (47, 116) 附近)
- **前置不满足**: Data 视图未切到 → 停下报告"切 Data 视图失败"。DATA 根节点 a11y 不见 → 停下报告"Data 树初始化未完成,可能 Chromeleon DB 加载延迟,等 5s 重查;再失败 abort"
- **动作**: 键盘焦点追踪(❌ 禁止用坐标点击子节点 — Tree 子节点 a11y 盲)
- **流程**(已实测 13/13 命中):
  ```
  click(47, 116)  → DATA selected
  key(escape)     → 清 IME 候选条
  key(down)       → focus → Instrument Data (89, 133)
  key(right)      → expand IData + advance to '2022' (83, 150)
  key(right)      → expand 2022 + advance to 'CEE6324' (112, 167)
  key(down) × 11  → 经各 user folder → realityloop (113, 354)
  ```
- **验证**: 每步 a11y_element 抓 focused TreeItem 的 name == 期望值;不一致即 abort
- **IME 陷阱**: ❌ 禁用字母键 typeahead,只方向键 + escape

##### Step 10: 右键点击 Li-test 模板 sequence
- **前置**: Step 9 完成,realityloop 已选中(状态栏 `Folder 'realityloop' selected`),`Li-test` 模板在 realityloop 下可见(键盘焦点能落到 Li-test TreeItem)
- **前置不满足**: **`Li-test` 模板不在 Data 树 → 停下报告"Li-test 模板不在 Data 树,询问用户是否换其他模板,不要继续"**
- **动作**: right_click
- **目标**: realityloop 下的 Li-test(主区或左树)
- **坐标**: `(123, 388)`(左树位置,主区也可用同行)
- **a11y**: TreeItemControl name=`Li-test`(realityloop 子节点,需键盘焦点)
- **命令**: `bridge.py right_click --x 123 --y 388`
- **验证**: 右键菜单弹出(13 项 Cut/Copy/Paste/Rename/Delete/...)

##### Step 11: 在右键菜单点击 Copy
- **前置**: Step 10 完成,右键菜单已弹出(用 `a11y_tree --scope desktop` 能抓到 13 项 MenuItemControl,首项 Cut 在 (262, 401))
- **前置不满足**: 菜单未弹 → 重试 Step 10 right_click 1 次;再失败 → 停下报告"右键菜单未弹出,Step 10 right_click 命中错误位置"
- **动作**: click
- **坐标**: `(262, 423)`(Step 10 触发点 +(139, 35))
- **a11y**: MenuItemControl name=`Copy`,**必须用 `a11y_tree --scope desktop`** 才能抓到(top-level menu)
- **命令**: `bridge.py click --x 262 --y 423`
- **验证**: 菜单关闭
- **关键**: 菜单是 transient,采集和点击间隔 < 2s

##### Step 12: 右键点击 realityloop 文件夹
- **前置**: Step 11 完成,clipboard 已复制 Li-test sequence 内容(clipboard 状态不可直接 verify,只能假设 Step 11 click 成功并触发 Copy)。若 Step 11 后右键菜单仍可见 → click 失败,abort
- **前置不满足**: 菜单仍可见 → 停下报告"Step 11 Copy click 未命中菜单项"
- **动作**: right_click
- **坐标**: `(113, 354)`(同 Step 9d 坐标)
- **a11y**: TreeItemControl name=`realityloop`
- **命令**: `bridge.py right_click --x 113 --y 354`
- **验证**: 右键菜单弹出(13 项含 New Folder / New Sequence... / Paste 等)

##### Step 13: 在右键菜单点击 Paste
- **前置**: Step 12 完成,realityloop 右键菜单已弹出(scope=desktop a11y 抓到 13 项 MenuItemControl 含 Paste / New Folder / New Sequence...);clipboard 含 sequence 数据
- **前置不满足**: 菜单未弹 → 重试 Step 12 right_click 1 次;再失败 abort。Paste 在菜单中是 disabled 状态 → 停下报告"clipboard 为空,Step 11 Copy 未生效"
- **动作**: click
- **坐标**: `(218, 411)`(Step 12 触发点 +(105, 57))
- **a11y**: MenuItemControl name=`Paste`(scope=desktop)
- **命令**: `bridge.py click --x 218 --y 411`
- **等待**: `Copying...` 对话框 1-3s 自动关闭
- **验证**: realityloop 下出现 `Li-test - Copy` 行

##### Step 14: 重命名 `Li-test - Copy` 为 `{SEQUENCE_NAME}`
- **前置**: Step 13 完成,realityloop 下出现 `Li-test - Copy` 行(主区或左树 a11y 可见)
- **前置不满足**: **`Li-test - Copy` 不存在 → 停下报告"sequence 复制失败,无法重命名,无法加入 Queue,SOP 终止于 Step 14,前置不满足"**
- **动作**: **5 步组合**(⚠️ 第 3 步前必走 IME 防御铁律,见上方"IME 防御铁律"段)
  1. **right_click** 在 `Li-test - Copy` 行(主区,需先定位行 y) + **a11y_tree scope=desktop** 找 Rename 菜单项
  2. **click** Rename 菜单项(位置=触发点 +(Δx, +85),Rename 是菜单第 4 项,间隔 22px)→ 此时 input 框激活,光标在文字上
  3. **🔧 IME 防御**:`hotkey --keys shift`(切英文输入法)→ 等 200ms
  4. **type** `{SEQUENCE_NAME}`(默认 `{DATE_PREFIX}-Li-test`,如 `20260425-Li-test`)→ 立即 `a11y_element` 验证 input 框 value 字段是否含完整字符串(若被 IME 吞,降级用 `hotkey --keys` 逐字符发,见 IME 防御铁律方案 A)
  5. **key** `enter` 提交
- **a11y**: MenuItemControl name=`Rename` (scope=desktop);input 框 a11y 通常 EditControl,verify 用 a11y_element name 含 sequence 旧名
- **验证**: realityloop 下出现 `{SEQUENCE_NAME}` 行(原 `Li-test - Copy` 消失)
- **失败处理**:
  - 重命名输入框未激活 → 重试 Step 14.2(再点一次 Rename,F2 兜底也 OK);连续失败 abort
  - **IME 拦截字母**(2026-04-25 trial 3 实测):type 后 a11y verify 看到 input 还是 `Li-test - Copy`(没改)或部分变成中文 → **走 IME 防御铁律方案 A 降级,用 hotkey 逐字符发**;**严禁**直接 retry type(IME 状态没切就 retry 等于无效)

### 阶段 C:检视 sequence 内容(Step 15–17)

##### Step 15: 双击新 sequence 打开编辑器
- **前置**: Step 14 完成,`{SEQUENCE_NAME}`(默认 `{DATE_PREFIX}-Li-test`)在 realityloop 下可见(a11y / 视觉确认)
- **前置不满足**: sequence 不存在 → 停下报告"重命名失败,Step 14 type 或 Enter 未生效,SOP 终止"
- **动作**: double_click(或单击,在 Chromeleon 单击树节点会自动打开主区编辑器)
- **目标**: `{SEQUENCE_NAME}` 行
- **坐标参考**: 视频里 `20260322-Li-test` 在 (148, 371)(realityloop 首子位置)
- **命令**: `bridge.py double_click --x 148 --y 371`(实际坐标按 Step 14 后位置定)
- **验证**: 顶部出现 `{SEQUENCE_NAME}` 标题,`Incomplete` + `Resume` 按钮

##### Step 16: 校验 8 行 injection 列表完整
- **前置**: Step 15 完成,sequence editor 已打开(顶部出现 `{SEQUENCE_NAME}` 标题 + Incomplete 状态徽章)
- **前置不满足**: editor 未打开 → 停下报告"双击未打开 sequence editor,可能 Step 15 命中错位"
- **动作**: verify only
- **期望**: 8 行(DI Blank × 1, 10/25/50/100 ppm Cal Std × 4, DI Blank × 1, None Blank × 2)
- **验证方式**: a11y / OCR 数行;a11y 对 DataGrid 盲 → 用 ocr_find 或 multimodal 看图
- **失败**: 行数 < 8 → **abort**(模板损坏)

##### Step 17: (可选)截图存档
- **前置**: Step 16 通过(injection 表 8 行齐全)
- **前置不满足**: Step 16 失败时跳过 17,直接 abort 报告(不存档损坏的 sequence)
- **动作**: screenshot only
- **命令**: `bridge.py screenshot` → mv 到 `/tmp/openclaw/screenshots/step17_seq_<ts>.png`

### 阶段 D:加 Queue + Ready Check + Start(Step 18–25)

##### Step 18: 切回 Instruments 视图
- **前置**: Step 15-17 完成,sequence editor 仍在主区(可关可不关)
- **前置不满足**: 同 Step 8(视图状态异常)
- **动作**: click
- **目标**: 左下导航 `Instruments`(顶项)
- **坐标**: `(182, 901)`
- **a11y**: ListItemControl name=`Instruments`
- **命令**: `bridge.py click --x 182 --y 901`
- **验证**: 状态栏 `Instrument 'HPIC' selected`,顶部 tab 行可见

##### Step 19: 点击顶部 Queue tab
- **前置**: Step 18 完成,Instruments 视图激活(顶部 8 个 tab 可见,Queue 在第 8 位 (872, 95))
- **前置不满足**: tab 不见 → 停下报告"Step 18 切 Instruments 失败"
- **动作**: click
- **坐标**: `(872, 95)`
- **a11y**: TabItemControl name=`m_TabPageQueueView`(第 8 个 tab)
- **命令**: `bridge.py click --x 872 --y 95`
- **验证**: 子 tab `Current | Recent` 出现,右侧按钮列 `Add... / Remove / Move Up / Move Down / Stop / Ready Check`

##### Step 20: 点击 Add... 按钮
- **前置**: Step 19 完成,Queue tab 激活(子 tab `Current | Recent` 可见,右侧按钮列 `Add... / Remove / Move Up / Move Down / Stop / Ready Check` a11y 全部可见)
- **前置不满足**: 按钮列不见 → 停下报告"Queue tab 未激活,Step 19 click 命中错位"
- **动作**: click
- **坐标**: `(1863, 144)`
- **a11y**: ButtonControl name=`Add...` aid=`m_ButtonAdd`
- **命令**: `bridge.py click --x 1863 --y 144`
- **验证**: `Add` 模态对话框弹出

##### Step 21: 在 Add 模态选中 `{SEQUENCE_NAME}`
- **前置**: Step 20 完成,Add 模态对话框已弹出(`Look in:` 显示 `realityloop`,文件列表加载完毕,a11y 可见 DataItemControl)
- **前置不满足**: 模态未弹 → 重试 Step 20 click 1 次;再失败 abort。`Look in:` 不是 realityloop → 用 Look 下拉手动导航到 `DATA / Instrument Data / 2022 / realityloop`。`{SEQUENCE_NAME}` 在文件列表中不见 → 停下报告"Step 14 命名失败或 sequence 不在 realityloop 下"
- **动作**: click
- **目标**: 模态文件列表中的 `{SEQUENCE_NAME}` 行
- **坐标**: 待 demo 当天采集(模态打开后 a11y_query 找 DataItemControl)
- **a11y**: DataItemControl,name 含 `{SEQUENCE_NAME}`
- **命令**: 模态弹后调 `bridge.py a11y_element --name "{SEQUENCE_NAME}" --depth 6` → 用返回 rect 中心 click
- **验证**: `Object` 字段自动填入 `{SEQUENCE_NAME}`
- **失败**: `Look in:` 不是 realityloop → 用 Look 下拉手动导航

##### Step 22: 点击模态底部 Add 按钮
- **前置**: Step 21 完成,sequence 已选中(模态 `Object` 字段填入 `{SEQUENCE_NAME}`,`Object` 下拉显示 `Sequence`)
- **前置不满足**: Object 字段为空 → 停下报告"模态文件列表选择失败,Step 21 未命中目标行"
- **动作**: click
- **坐标**: `(1130, 712)`
- **a11y**: ButtonControl name=`Add` aid=`m_ButtonPart`(注意:与 Step 20 的 `Add...` 区分,这个无三点)
- **命令**: `bridge.py click --x 1130 --y 712`
- **验证**: 对话框关闭,Queue 主表格新增 `/DATA/Instrument Data/{DATA_YEAR}/{USER_FOLDER}/{SEQUENCE_NAME}` 行,Status=`Pending`

##### Step 23: 点击 Ready Check
- **前置**: Step 22 完成,模态对话框已关闭,Queue 主表格出现 sequence 行(Name 列显示 `/DATA/Instrument Data/{DATA_YEAR}/{USER_FOLDER}/{SEQUENCE_NAME}`,Status=`Pending`)
- **前置不满足**: **Queue 仍空 → 停下报告"Step 22 Add 失败,sequence 未入队,SOP 终止于 Step 23,严禁在空 Queue 上按 Ready Check"**
- **动作**: click
- **坐标**: `(1863, 331)`
- **a11y**: ButtonControl name=`Ready Check` aid=`m_ButtonReadyCheck`
- **命令**: `bridge.py click --x 1863 --y 331`
- **等待**: 5-15s 转圈

##### Step 24: 等待并校验 Ready Check 结果
- **前置**: Step 23 已点击,Ready Check 在执行(转圈 5-15s)
- **前置不满足**:
  - 60s 超时无结果 → **abort**(仪器卡死)
  - `Ready check result: Failed` → **abort**,把 Audit 表格里最近 5 行错误原因 + 截图返回 main
  - **HPIC 未连接 / Sampler 异常 → calibration_mode=ui_only 时这是预期失败**,exec-remote **必须停下报告**:"calibration_mode=ui_only,HPIC 未连(或 Sampler `Too many errors`),Ready Check 预期失败,SOP 终止于 Step 24,前置不满足。已点 Ready Check 验证按钮坐标 (1863, 331) 命中,Step 25 Start 因 Ready Check 未通过严禁强按。"
- **动作**: wait + verify
- **期望文字**: `Ready check result: Successful.`
- **超时**: 60s
- **失败处理**:
  - `Ready check result: Failed` → **abort**,把 Audit 错误回报 main(不要硬启动)
  - 超时无结果 → **abort**(仪器卡死)
  - **HPIC 未连接 → 此步 100% 失败**,calibration_mode=ui_only 时这是预期失败,exec-remote 应 stop 并报告"calibration_mode=ui_only,HPIC 未连,Ready Check 失败属预期,SOP 终止于 Step 24"

##### Step 25: 点击 Start
- **前置**: **Step 24 Ready Check 必须 Successful** + Start 按钮从 disabled 变 enabled(a11y 能查到 ButtonControl name=`Start`,rect 非 (0,0))
- **前置不满足**: **Step 24 失败 → 严禁强按 Start,abort 报告**。Start 按钮仍 disabled (a11y 找不到) → 停下报告"Step 24 通过但 Start 未 enabled,可能仪器状态异常"。**任何"硬按 Start 让它跑跑看"的解读都是错误,SOP 在 Step 24 失败时必须停**
- **动作**: click
- **坐标**: **未采**(disabled 时 a11y 过滤;预测 (1863, 277) 在 Move Down y=224 与 Stop y=304 之间)
- **a11y**: ButtonControl name=`Start`(只在 Ready Check 通过后 enabled 才出现)
- **命令**: 必须先 `bridge.py a11y_element --name "Start" --control-type ButtonControl` 实测坐标
- **前置铁律**: **Step 24 必须 Successful**;否则 abort,**严禁强按 Start**
- **验证**: Status `Pending → Running`

### 阶段 E:监控运行(Step 26–28)

##### Step 26: 切回 Pump_ECD tab
- **前置**: Step 25 已成功(Status: `Pending → Running`,sequence 真在跑)
- **前置不满足**: Status 未变 → abort。 calibration_mode=ui_only 时若 SOP 已在 Step 24 终止,**不应到达 Step 26**
- **动作**: click
- **坐标**: `(529, 95)`(同 Step 4)
- **命令**: `bridge.py click --x 529 --y 95`
- **验证**: 主区右上 chromatogram `0.000/{RUN_DURATION_MIN}.000`,Pressure 跃升到 ~2400 psi

##### Step 27: 截图存档
- **前置**: Step 26 完成,Pump_ECD tab 显示 chromatogram + run timer (`0.000/{RUN_DURATION_MIN}.000`)
- **前置不满足**: 主区未切回 Pump_ECD → abort
- **动作**: screenshot
- **命令**: `bridge.py screenshot` → mv `/tmp/openclaw/screenshots/step27_running_<ts>.png`

##### Step 28: 返回 dispatcher JSON
- **前置**: 所有前序 step 已完成(或 partial,在 Step 24 / 其他 abort 点终止),evidence_screenshots 已落到 `/tmp/openclaw/screenshots/`
- **前置不满足**: 截图缺失 → status 改 `partial`,summary 注明缺失原因。SOP 在中途 abort → status=`failed` 或 `partial`,`stopped_at_step` + `stop_reason` 必填
- **动作**: 输出 JSON
```json
{
  "status": "ok|partial|failed",
  "summary": "<1-3 句中文>",
  "evidence_screenshots": ["/tmp/openclaw/screenshots/step*.png", ...],
  "stopped_at_step": 24,           // 如果 partial/failed
  "stop_reason": "calibration_mode=ui_only,HPIC 未连,Ready Check 失败"
}
```

---

## 风险点清单(中止 vs 重试)

| Step | 失败现象 | 处理 |
|------|---------|------|
| 1    | Chromeleon 不在前台 | **abort**,要求人工启动 |
| 3    | 连接超时 (>30s) | **abort**,Instrument Controller 死 |
| 7    | 高压报警 (pressure > 4900 psi) | **abort**,物理隐患,不重试 |
| 11/13 | 右键菜单不出现 | 重试 1 次(可能 a11y 抖动);连续失败 abort |
| 14   | 重命名输入框未激活 | 重试 1 次(F2 兜底);连续失败 abort |
| 16   | sequence 行数 < 8 | **abort**,模板损坏 |
| 21   | Add 对话框找不到 sequence | 检查 Step 14 命名;改用 Look 下拉 |
| 24   | Ready Check Failed / 超时 | **abort**,把 Audit 错误回报,**严禁硬启动** |
| 25   | Start 按钮灰 | 回到 Step 23 重做 Ready Check(最多 2 次) |

**总结**:[abort] step 共 **7 个**(Step 1, 3, 7, 16, 24, queue add 找不到模板, Start 灰太久)。

---

# 参考资料(LLM 执行时优先读顶部 SOP 大纲,本段为查询用)

> 以下章节为 dry-run 校准产出 + 通用工具指南。LLM 执行业务任务时按上方"SOP 主流程详细指令"执行;本段供需要查证 / 排查时参考。

## 已校准坐标表汇总(2026-04-25 dry-run,1920×1080,DPI 100%)

| Step | label | click center (x, y) | controlType | 实际 a11y name / aid | 备注 |
|------|-------|--------------------|-------------|---------------------|------|
| 1    | Chromeleon Console (verify) | (960, 516) | WindowControl | `ShellForm,Chromeleon Console #5,Left` | verify only,可跳点击 |
| 2    | HPIC | (40, 183) | ListItemControl | `HPIC` | 已连接时点击无变化 |
| 4/26 | Pump_ECD tab | (529, 95) | TabItemControl | aid=GUID `m_6d8b20b9-...` | tab 名是 GUID,坐标点击 |
| 5/7  | Pump_ECD On | (768, 411) | ButtonControl | name=`On` aid=`m_a61bc10e...` | y≥380 区分 Suppressor |
| 6    | Pump_ECD Off | (768, 456) | ButtonControl | name=`Off` aid=`m_9cd91f49...` | 同上 |
| 8    | Data 导航 | (182, 933) | ListItemControl | `Data` | 左下导航中间 |
| 9a   | DATA tree | (47, 116) | TreeItemControl | `DATA` | 树根 |
| 9b   | Instrument Data | (89, 133) | TreeItemControl | `Instrument Data` | 键盘 ↓ 1 次 |
| 9c   | 2022 | (83, 150) | TreeItemControl | `2022` | 键盘 → 进 IData |
| 9d/12| realityloop | (113, 354) | TreeItemControl | `realityloop` | 键盘 → 进 2022 + ↓×11 |
| 10/15| Li-test | (123, 388) | TreeItemControl | `Li-test` | 键盘 → 进 realityloop + ↓×1 |
| 11   | Copy menu | (262, 423) | MenuItemControl | `Copy` | scope=desktop |
| 13   | Paste menu | (218, 411) | MenuItemControl | `Paste` | scope=desktop |
| 18   | Instruments 导航 | (182, 901) | ListItemControl | `Instruments` | 左下导航顶 |
| 19   | Queue tab | (872, 95) | TabItemControl | `m_TabPageQueueView` | 第 8 个 tab |
| 20   | Add... | (1863, 144) | ButtonControl | `m_ButtonAdd` | 右侧按钮列首 |
| 22   | Add (modal) | (1130, 712) | ButtonControl | `m_ButtonPart` | 模态底部 |
| 23   | Ready Check | (1863, 331) | ButtonControl | `m_ButtonReadyCheck` | 右侧按钮列倒 2 |
| **25** | **Start** | **未采** | — | — | a11y 过滤,demo 当天补 |

## 顶部 8 个 Tab 位置表(全部 y=95)

| 索引 | SOP label | a11y name | click center |
|-----:|-----------|-----------|--------------|
| 0 | Home | `m_TabPageHome` | (407, 95) |
| 1 | Sampler | GUID `m_1d140723-...` | (463, 95) |
| 2 | Pump_ECD | GUID `m_6d8b20b9-...` | (529, 95) |
| 3 | CDet | GUID `m_dea37357-...` | (585, 95) |
| 4 | Electrolytics | GUID `m_ada3a545-...` | (662, 95) |
| 5 | Audit | `m_TabPageAuditView` | (746, 95) |
| 6 | Startup | `m_TabPageEquilibration` | (809, 95) |
| 7 | Queue | `m_TabPageQueueView` | (872, 95) |

→ Chromeleon 顶部 tab 多数 a11y `name` 是 GUID,**`smart_click --name "Pump_ECD"` 不可达**。必须坐标或 `--automation-id`。

## Data 树导航:键盘 ↓/→ + 焦点追踪(标准模式)

Chromeleon 的 TreeControl(`m_TreeFolders`)对 a11y **结构性盲**:只曝露当前 focused TreeItemControl,其他子节点 `Element not found`。

**标准模式**:
| 操作 | 键盘 | a11y |
|------|-----|------|
| 选中根节点 | `click(47, 116)` | 焦点入树 |
| 展开 + 前进首子 | `→` | 新 focused 节点曝露 |
| 折叠 | `←` | — |
| 同级跳转 | `↓` / `↑` | 每按一次新 focused 节点 |
| 选中叶子并打开 | `↓` 落到目标 | 单击行为:sequence 自动主区打开 |

**实测全链 13/13 命中**:`DATA → ↓ → Instrument Data → → → 2022 → → → CEE6324 → ↓×11 → realityloop → → → 20260322-Li-test → ↓ → Li-test`

**⚠️ IME 陷阱**:Win11 中文版默认 Pinyin IME 拦截字母键。typeahead 失效。**只用方向键 + escape + Enter**。如出现 IME 候选条,先 `key=escape`。

## 右键菜单 a11y 抓取模式

右键菜单是 **top-level window**,用 `a11y_tree?scope=desktop&max_depth=8` 抓 MenuItemControl。anchor 在 Chromeleon Console 上抓不到。

**菜单弹出位置**:
- 首项中心 = 右键触发点 + `(Δx=+105~+139, Δy=+13)`
- 各行间隔 22px
- 例:Li-test 触发点 (123, 388) → 首项 Cut (262, 401),Copy (262, 423,第 2 项),Rename (262, 467,第 4 项)

**完整 13 项菜单**(Li-test):Cut → Copy → Paste → Rename → Delete → Delete Raw Data... → Print Report... → Export... → Convert to Chromeleon Processing → Read-Only → Send To... → Show Data Audit Trail... → Properties...

**完整 13 项菜单**(realityloop):Cut → Copy → Paste → Rename → Delete → New Folder → New Sequence... → New Query → Read-Only → Send To... → CSV Export → Show Data Audit Trail... → Properties...

**关键**:采集后必须 `key=escape` 关闭菜单。

## Dry-run 最终覆盖摘要

- a11y 直接命中:Step 1/4/5/6/7/8/18/19/26(9 项)
- 键盘 ↓/→ + 焦点追踪:Step 9a/9b/9c/9d/10/12/15(7 项)
- Queue tab a11y:Step 20/22/23(3 项)
- 右键 desktop scope:Step 11/13(2 项;14a 推断)
- 未采:Step 25 Start(disabled,demo 当天补)
- removed:Step 2(HPIC,user 判定)
- no_target:Step 14b/14c/16/17/24/27/28(7 项)

完整 dry-run 报告:`sandbox/rag-healthcheck/DRYRUN_FINAL_20260425T175025.md`
来源视频:`/Users/realityloop/Downloads/SOP.mp4`(115.92s 录屏,Windows B → Chromeleon 7.2.10 ES)

## 降级方案(exec-remote 不可用时人工台本)

1. dispatcher 收到指令原文转交人工
2. 操作员对照 Step 1–28 在 Windows B 手动执行
3. 关键截图(Step 1, 9, 14, 22, 25, 27)人工拍照上传飞书
4. 任一 [abort] 现象立即停止并回传

---

# Win Remote Control 通用工具指南(适用所有 win-remote-control 任务,SOP 无关)

## ⚠️ 点击铁律(必须遵守)

**所有点击操作,第一步必须是 `smart_click`**(除已知 GUID-name 控件如 Chromeleon tabs)。
禁止直接调用 `ocr_click` / `a11y_click` / `click` 作为第一次尝试。
只有 `smart_click` 明确返回失败,才允许降级到 ocr_click / patch_click / 直接坐标 click。

```
每次点击 = smart_click 优先
↓ smart_click 返回 success:false
→ 再考虑 ocr_click / patch_click / finalize / 已知坐标
```

## 能力总览与优先级

### 最高优先:smart_click 三级降级

```bash
python3 {baseDir}/bridge.py smart_click --name "Off"
python3 {baseDir}/bridge.py smart_click --name "Queue"
python3 {baseDir}/bridge.py smart_click --name "Connect" --control-type ButtonControl
python3 {baseDir}/bridge.py smart_click --name "Chromeleon 7" --double
python3 {baseDir}/bridge.py smart_click --name "Li-test" --x 220
python3 {baseDir}/bridge.py smart_click --name "Queue" --focus-window "Chromeleon Console"
python3 {baseDir}/bridge.py smart_click --name "Off" --verify
```

降级:1) a11y(<200ms) → 2) OCR(1-2s) → 3) fallback(patch_click)

### 单独使用 a11y

```bash
python3 {baseDir}/bridge.py a11y_tree --max-depth 5
python3 {baseDir}/bridge.py a11y_element --name "Off" --depth 4
python3 {baseDir}/bridge.py a11y_click --name "Queue"
python3 {baseDir}/bridge.py a11y_click --automation-id "m_85ecf080-..." --double
python3 {baseDir}/bridge.py focus_window --name "Chromeleon Console"
```

### 单独使用 OCR

```bash
python3 {baseDir}/bridge.py ocr_find --name "Pending"
python3 {baseDir}/bridge.py ocr_find --name "Li-test" --x 220
python3 {baseDir}/bridge.py ocr_click --name "Click here to add a new injection"
```

OCR 适用:DataGrid 内容 / 自绘文字 / 数值读取(a11y 盲)。

### 视觉两阶段(纯图标)

```bash
python3 {baseDir}/bridge.py patch_click --target "Chrome 图标" --rough-x 120 --rough-y 900
python3 {baseDir}/bridge.py finalize --local-x 180 --local-y 140 --offset-x 0 --offset-y 920 --double
```

### 基础操作

```bash
python3 {baseDir}/bridge.py screenshot
python3 {baseDir}/bridge.py click --x 960 --y 540
python3 {baseDir}/bridge.py double_click --x 960 --y 540
python3 {baseDir}/bridge.py right_click --x 960 --y 540
python3 {baseDir}/bridge.py type --text "..."
python3 {baseDir}/bridge.py move_mouse --x 960 --y 540
python3 {baseDir}/bridge.py scroll --x 960 --y 540 --clicks -3
python3 {baseDir}/bridge.py run_exe --path "https://www.bilibili.com"
python3 {baseDir}/bridge.py key --key enter
python3 {baseDir}/bridge.py hotkey --keys ctrl,c
```

## 已知限制

- `key`/`hotkey` 焦点未锁定时无效。
- `run_exe` 对 WeChat/QQ 可能 500。
- 锁屏时操作失败。
- a11y:WebView 内容不可访问;DataGrid 行/单元格通常不暴露(读表用 ocr_find);TreeView 子节点结构性盲(用键盘焦点追踪)。
- OCR:小字体可能误读;同名需 `--x`/`--y` 区域约束;纯图标无能。
- 右键菜单 a11y 必须 `scope=desktop`,anchor 在 app 上抓不到。
- 中文 Win11 默认 Pinyin IME 拦截字母键 typeahead → 只用方向键。

## 推荐流程

### 点击决策树

```
需要点击某元素?
有文字标签?
  ├─ 是 → smart_click --name "..."(自动 a11y→OCR→fallback)
  │        同名多个 → 加 --x/--y/--control-type
  │        smart_click fallback → patch_click 视觉两阶段
  └─ 否(纯图标) → patch_click 视觉两阶段

读文字/数值(不点击)?
  → ocr_find --name "..."

控件 a11y name 是 GUID(如 Chromeleon tabs)?
  → 已知坐标 click 或 a11y_click --automation-id
```

### 桌面图标点击铁律

1. 先截图,再定位;禁止经验坐标双击。
2. 同时核对图标外观 + 文字标签;只认图标视为高风险。
3. 标签过小/邻近过密 → 先单击候选制造选中态,再截图复核。
4. 二次确认后才执行双击。
5. 点击后必须再截图;失败立即停止。

## 参数说明

| action | 参数 | 说明 |
|--------|-----|------|
| `screenshot` | 无 | 保存截图到本地 |
| `screen_size` | 无 | 远端屏幕尺寸 |
| `click` | `--x`, `--y` | 单击 |
| `double_click` | `--x`, `--y` | 双击 |
| `right_click` | `--x`, `--y` | 右键 |
| `move_mouse` | `--x`, `--y` | 移动鼠标 |
| `scroll` | `--x`, `--y`, `--clicks` | 滚轮 |
| `type` | `--text` | 输入文字 |
| `key` | `--key` | 单键 |
| `hotkey` | `--keys` | 组合键 |
| `run_exe` | `--path` | 打开 URL/启动 |
| `patch_click` | `--target`, `--rough-x`, `--rough-y` | 局部裁剪图 |
| `finalize` | `--local-x`, `--local-y`, `--offset-x`, `--offset-y`, `--double` | 局部坐标完成点击 |
| `focus_window` | `--name` | 激活窗口 |
| `a11y_tree` | `--max-depth`, `--scope` | 树查询 |
| `a11y_element` | `--name`, `--control-type`, `--automation-id`, `--depth`, `--scope` | 单元素查询 |
| `a11y_click` | 同上 + `--double`, `--focus-window`, `--verify` | a11y 点击 |
| `ocr_find` | `--name`, `--x`, `--y` | OCR 搜索 |
| `ocr_click` | 同上 + `--double`, `--verify` | OCR 点击 |
| `smart_click` | 全参数 | 三级降级(推荐默认) |

## 实战原则

- smart_click 默认入口
- a11y 优先,OCR 补盲区
- 同名消歧:`--x`/`--y` 或 `--control-type`
- 后台窗口:先 `focus_window` 或 `--scope desktop`
- GUID name(如 Chromeleon tabs):坐标或 `--automation-id`
- 纯图标:patch_click/finalize
- URL:run_exe
- 404/500 立即切备选(`key`/`hotkey` 在某些服务器返回 404)
- 锁屏:提示人工解锁
- 截图链路断裂:停止盲点,汇报现状

## 置信度规则(视觉点击必须遵守)

| 置信度 | 含义 | 行动 |
|-------|-----|------|
| 85–100 | 目标清晰 | 直接 finalize |
| 60–84 | 轻微歧义 | finalize 但验证截图重点核 |
| <60 | 模糊/多候选 | **禁止 finalize**,重新 patch_click |

考虑因素:外观唯一性 / 文字标签可读性 / 邻近间距(<10px 降低)。
