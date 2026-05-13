---
name: semantic-scholar
description: 查找生化环材及各学科学术论文。当用户询问"最新进展"、"相关研究"、"查一下某领域论文"、"有没有关于X的研究"时调用。覆盖2亿+篇论文，含Nature/Science/JACS等主流期刊，无需API key。
---

# Semantic Scholar

覆盖生物、化学、材料、环境科学、医学、工程等全学科，2亿+篇论文，免费无需 API key。

## 基本搜索

```bash
python3 {baseDir}/scripts/search.py "关键词" --max 10
```

## 常用参数

```bash
# 限制年份范围
python3 {baseDir}/scripts/search.py "perovskite solar cell" --year 2022-

# 限定领域
python3 {baseDir}/scripts/search.py "CO2 capture" --field chemistry --max 10

# 只看开放获取（有免费 PDF）
python3 {baseDir}/scripts/search.py "lithium battery" --open-access

# JSON 输出（便于后续处理）
python3 {baseDir}/scripts/search.py "graphene" --json --max 20
```

## 领域参数（--field）

| 参数值 | 对应方向 |
|---|---|
| `chemistry` | 化学 |
| `biology` | 生物 |
| `medicine` | 医学 |
| `materials-science` | 材料 |
| `environmental-science` | 环境 |
| `engineering` | 工程 |
| `physics` | 物理 |

## 获取单篇论文详情

```bash
python3 {baseDir}/scripts/search.py get <S2_paper_id>
python3 {baseDir}/scripts/search.py get "DOI:10.1038/s41586-023-00001-0"
```

## 无需安装任何依赖

只用 Python 标准库，开箱即用。

## 禁止行为
- 禁止使用 `web_fetch` 或 `web_search`
- 所有检索只通过上方 Bash 脚本执行
