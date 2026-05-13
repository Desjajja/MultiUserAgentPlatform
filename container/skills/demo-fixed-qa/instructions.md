---
name: demo-fixed-qa
description: Demo fixed-answer skill for lab execution scenes (5+). It returns deterministic OpenClaw-style responses for pre-defined user questions with no model creativity.
---

# Demo Fixed QA

## Purpose

Use this skill for demo mode when the user asks questions from the fixed lab script (scene 5 and later).

This skill must return **deterministic fixed replies** from a local mapping file.

## Behavior Rules

1. Do not rewrite, summarize, or paraphrase mapped answers.
2. If input exactly matches a configured question (`items[].questions`), output the mapped answer directly.
3. Legacy compatibility: if `questions` does not hit, `patterns` can still be used as fallback.
4. If input does not match, output exactly:

```text
未命中固定问答，请补充该问题到 demo-fixed-qa 映射。
```

## Execution

Run:

```bash
python3 {baseDir}/scripts/fixed_qa.py --question "<user_text>"
```

Interactive mode:

```bash
python3 {baseDir}/scripts/fixed_qa.py --interactive
```

## Mapping File

- Path: `{baseDir}/data/qa_map.json`
- Fields:
  - `items[].id`
  - `items[].questions` (exact question match, recommended)
  - `items[].patterns` (substring fallback, optional)
  - `items[].answer` (fixed output)
