---
name: semantic-scholar
description: Search Semantic Scholar (200M+ papers) via web_fetch. Use for cross-discipline academic search, especially when arXiv does not have what you need.
---

# semantic-scholar (nanoclaw native)

Use `web_fetch` against Semantic Scholar's public Graph API. **Do not** try to run python scripts in the skill folder — the container has no Python.

## Paper search

```
https://api.semanticscholar.org/graph/v1/paper/search?query=<URL-encoded>&limit=<N>&fields=title,abstract,year,authors,citationCount,externalIds
```

Returns JSON `{data: [{title, abstract, year, authors, citationCount, externalIds:{ArXiv,DOI}}, ...]}`. Parse and format:
- Title (year, citationCount)
- 1-sentence summary from abstract
- ArXiv id / DOI if available

## Single-turn rule

Call `web_fetch` directly in the same response — do NOT send a "正在查询..." ack first. nanoclaw delivers one outbound per turn.

## Rate limits

Public API: roughly 100 requests / 5 min unsigned. If you get 429, say so and stop — do not retry.
