---
name: websearch
description: 通用网页搜索。当用户说"搜一下"、"网上查"、"帮我查"、"最新应用"、"行业动态"等，且内容不属于学术论文时，调用此技能。使用 DuckDuckGo，无需 API key。
---

# Web Search

通过 DuckDuckGo 搜索网页内容。不依赖任何外部 API key。

## 执行

```bash
python3 {baseDir}/scripts/search.py "查询关键词" --max 10
```

中文内容加 `--region cn-zh` 效果更好：

```bash
python3 {baseDir}/scripts/search.py "查询关键词" --region cn-zh --max 10
```

JSON 输出：

```bash
python3 {baseDir}/scripts/search.py "查询关键词" --json --max 10
```

## 安装依赖

```bash
pip install duckduckgo-search
```

## 输出格式

```
1. 标题
   https://example.com
   摘要内容...

2. ...
```

## 使用原则

- 查学术论文 → 用 `semantic-scholar`（生化环材全领域）或 `arxiv`（物理/CS 预印本）
- 查网页、新闻、行业动态、产品应用 → 用本 skill
- 关键词尽量简洁，中文查询建议加 `--region cn-zh`

## 禁止行为
- **禁止使用 `web_fetch` 或 `web_search`**：这两个是 Claude Code 内置工具，在 OpenClaw 中不可用
- 所有搜索只通过上方 Bash 脚本执行
