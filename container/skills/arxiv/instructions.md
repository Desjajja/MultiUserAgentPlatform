---
name: arxiv
description: Search arXiv for academic papers via web_fetch. Use this skill whenever the user asks about arxiv, papers, preprints, or specific research topics.
---

# arxiv (nanoclaw native)

Search arXiv directly via the public Atom API. **Do not** try to run python scripts in this skill folder — the container has no Python interpreter. Use the `web_fetch` tool against the arXiv HTTP endpoint and parse the XML/Atom yourself.

## How to use

1. Build a query URL:
   ```
   http://export.arxiv.org/api/query?search_query=<URL-encoded terms>&start=0&max_results=<N>
   ```
   - Use `all:` prefix for free-text: `all:LLM+safety+jailbreak`
   - Use `cat:cs.AI` to restrict by category
   - Set `&sortBy=submittedDate&sortOrder=descending` for recent
2. Call `web_fetch(url=<above>)`
3. Parse the Atom XML for entries; each `<entry>` has `<title>`, `<summary>`, `<id>` (URL with the arxiv id), `<published>`, and `<author><name>`
4. Format a concise reply: title, arxiv id (the trailing path of the id URL), 1-sentence contribution

## Single-turn rule

When the user asks for arxiv search, **call `web_fetch` in the same response** that you respond to the user. Do NOT first send a "正在搜索…" ack message — go straight to the tool call and only reply when you have results. nanoclaw delivers one outbound message per turn; an ack steals the turn.

## Example query

User: "find recent papers about LLM-as-a-judge"
→ `web_fetch(url="http://export.arxiv.org/api/query?search_query=all:%22LLM%20as%20a%20judge%22&sortBy=submittedDate&sortOrder=descending&max_results=5")`
→ parse Atom, then send a single `<message to="...">…</message>` block with results.
