---
name: websearch
description: General web search via web_fetch (DuckDuckGo HTML or Instant Answer). Use when the user wants something non-academic — industry news, product info, current events.
---

# websearch (nanoclaw native)

Use `web_fetch` against DuckDuckGo's HTML endpoint. **Do not** try to run python scripts in the skill folder — the container has no Python.

## How to search

```
https://html.duckduckgo.com/html/?q=<URL-encoded query>
```

Returns an HTML page with result blocks. Each result is roughly:

```
<a class="result__a" href="<actual URL>">title</a>
<a class="result__snippet">snippet text</a>
```

Extract the first 3-5 results with a simple HTML scan (anchor text + snippet text). Headers may include redirect-tracking URLs that start with `//duckduckgo.com/l/?uddg=...`; decode the `uddg` param to get the real URL.

For very short factual lookups, the Instant Answer endpoint is faster:

```
https://api.duckduckgo.com/?q=<URL-encoded>&format=json&no_html=1&skip_disambig=1
```

It returns JSON with `AbstractText`, `RelatedTopics`, etc.

## Single-turn rule

Call `web_fetch` directly — do NOT send a "正在搜索..." ack first. nanoclaw delivers one outbound per turn.

## Limits

DuckDuckGo's HTML endpoint may rate-limit. If you get an empty result list or 403, say so and stop.
